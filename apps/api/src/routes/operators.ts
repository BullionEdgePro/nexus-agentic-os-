import { Hono } from "hono";
import {
  listOpenFindings,
  countOpenFindings,
  lastSeenByOperator,
  listJobHeartbeats,
  findOrganizationBySlug,
} from "@nexus/db";
import { isJobStalled } from "@nexus/shared";
import { OPERATORS } from "../services/operators.js";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * What the operators have found.
 *
 * Scoped per role in the handler, like /api/tasks and for the same reason: this
 * path carries no :slug, so `requireTenantScope` does not apply and the request
 * runs in a cross-tenant database context. If this handler forgets to narrow,
 * an employee reads five businesses' findings — each of which names a customer
 * — and the response looks entirely normal.
 *
 * Not operator-only: a finding is work, and the person who can act on
 * "your customer has been waiting three hours" is the one who should see it.
 */
export const operatorsRoute = new Hono();

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

operatorsRoute.get("/", async (c) => {
  const scope = scopeOf(c);

  let organizationId: string | null = null;
  if (scope.role === "operator") {
    const slug = c.req.query("business");
    if (slug) {
      const organization = await findOrganizationBySlug(slug);
      if (!organization) return c.json({ error: "Organization not found" }, 404);
      organizationId = organization.id;
    }
  } else {
    organizationId = scope.organizationId ?? null;
    if (!organizationId) {
      logger.warn({ sub: scope.sub }, "Employee session without an organization asked for findings");
      return c.json({ error: "Your account is not attached to a business." }, 403);
    }
  }

  const [findings, counts, lastSeen, heartbeats] = await Promise.all([
    listOpenFindings(organizationId),
    countOpenFindings(organizationId),
    lastSeenByOperator(organizationId),
    // Migration 050. Not tenant-scoped and correctly so — the sweep runs across
    // every business at once, so its liveness is one fact rather than five.
    listJobHeartbeats().catch(() => []),
  ]);

  // WHEN THE SWEEP LAST RAN, because the page was asserting it.
  //
  // "Nothing needs attention … checked within the last ten minutes" was
  // hardcoded prose. If the sweep stops, `operator_findings` stops changing,
  // the count stays at zero, and that sentence goes on reassuring somebody
  // indefinitely — which is the exact failure migration 050 exists to end,
  // rendered as good news.
  //
  // `lastSeenAt` per operator cannot answer this: it comes from findings, so an
  // operator that has never found anything is null forever whether or not it
  // ran. The heartbeat is the only record that the sweep HAPPENED.
  const sweep = heartbeats.find((beat) => beat.job === "operators");
  const lastSweptAt = sweep?.lastFinishedAt ?? null;

  return c.json({
    findings,
    counts,
    lastSweptAt,
    // Computed here rather than in the browser: the tolerance lives in
    // @nexus/shared beside the schedule it judges, and a second copy in the web
    // app would be a second thing to forget when the interval changes.
    //
    // Judged from the API process's own start, which is the only clock this
    // handler has. It errs toward silence right after a deploy, which is the
    // right direction for a banner.
    sweepStalled: isJobStalled(
      "operators",
      lastSweptAt ? new Date(lastSweptAt) : null,
      new Date(),
      new Date(Date.now() - process.uptime() * 1000)
    ),
    // The roster comes from CODE, not from the findings table. Deriving it from
    // stored rows would mean an operator that has never found anything simply
    // does not exist as far as the page is concerned — and "no findings" and
    // "not running" would render identically, which is the difference between
    // good news and a broken sweep.
    operators: OPERATORS.map((operator) => ({
      slug: operator.slug,
      title: operator.title,
      description: operator.description,
      lastSeenAt: lastSeen[operator.slug] ?? null,
    })),
  });
});
