import { Hono } from "hono";
import {
  withTenant,
  findOrganizationBySlug,
  getQualityTrend,
  summarise,
  getSharedGuidance,
  getBrainStatus,
  getEscalationHotspots,
} from "@nexus/db";
import { askCopilot, copilotCapabilities } from "@nexus/agents";
import { rollUpRecentQuality } from "../services/quality-rollup.js";
import { logger } from "../lib/logger.js";

/**
 * Agent quality for one business.
 *
 * Operator-only at the mount: this is how well someone's staff and agent are
 * performing, which is management information rather than something an employee
 * should read about their colleagues.
 */
export const qualityRoute = new Hono();

// Platform-wide patterns. Mounted before /:slug so the literal path is not
// swallowed by the parameter — Hono matches in declaration order, and a
// business called "shared" is not the failure mode here; the route simply
// never being reached is.
qualityRoute.get("/shared", async (c) => {
  const [patterns, status] = await Promise.all([getSharedGuidance(), getBrainStatus()]);
  return c.json({ patterns, status });
});

qualityRoute.get("/:slug", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 180);
  // INSIDE A TENANT CONTEXT, which this route did without until 2026-08-19.
  //
  // `agent_quality_daily` had no row-level security — one of four tenant tables
  // that never made it onto any of the three hand-maintained lists — so an
  // unscoped read here returned rows anyway, held correct by the explicit
  // `where organization_id = $1` in each query and nothing else. That is the
  // forgotten-WHERE-clause exposure RLS exists to make impossible, and it is
  // also why enabling the policy without this line would have emptied the
  // Quality page: no context, no rows.
  const [trend, hotspots] = await withTenant(organization.id, () =>
    Promise.all([
      getQualityTrend(organization.id, days),
      getEscalationHotspots(organization.id, days),
    ])
  );

  return c.json({ trend, summary: summarise(trend), hotspots });
});

// Forces a recompute. Useful right after the feature ships, when no scheduled
// run has happened yet and the page would otherwise be empty for an hour with
// no way to tell "no data" from "not computed yet".
qualityRoute.post("/refresh", async (c) => {
  try {
    const dayRows = await rollUpRecentQuality(7);
    return c.json({ dayRows });
  } catch (err) {
    logger.error({ err }, "Manual quality rollup failed");
    return c.json({ error: "Could not compute rollups" }, 500);
  }
});

// What the copilot can answer, so the UI can say so before anyone is
// disappointed by a refusal. An empty ask box invites questions the feature
// cannot take, and a refusal after the fact reads as a failure rather than a
// boundary.
qualityRoute.get("/:slug/capabilities", (c) => c.json({ capabilities: copilotCapabilities() }));

qualityRoute.post("/:slug/ask", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = await c.req.json<{ question?: string }>().catch(() => null);
  const question = body?.question?.trim();
  if (!question) return c.json({ error: "Ask a question" }, 400);
  // Bounded before it reaches the model. An unbounded field on an authenticated
  // endpoint is a way to spend someone else's inference budget.
  if (question.length > 500) return c.json({ error: "That question is too long" }, 400);

  try {
    // Same reason as the trend handler above: the copilot's four queries all
    // read `agent_quality_daily`, and every one of them would return nothing
    // once the policy is on.
    const answer = await withTenant(organization.id, () =>
      askCopilot(organization.id, question)
    );
    logger.info({ slug: organization.slug, matched: answer.matched }, "Copilot question");
    return c.json(answer);
  } catch (err) {
    logger.error({ slug: organization.slug, err }, "Copilot failed");
    return c.json({ error: "Could not answer that right now." }, 502);
  }
});
