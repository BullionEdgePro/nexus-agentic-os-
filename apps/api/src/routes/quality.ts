import { Hono } from "hono";
import { findOrganizationBySlug, getQualityTrend, summarise } from "@nexus/db";
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

qualityRoute.get("/:slug", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const days = Math.min(Math.max(Number(c.req.query("days") ?? 30), 1), 180);
  const trend = await getQualityTrend(organization.id, days);

  return c.json({ trend, summary: summarise(trend) });
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
