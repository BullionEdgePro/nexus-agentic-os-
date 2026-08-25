import { Hono } from "hono";
import type { Context } from "hono";
import {
  listOpenFindings,
  countOpenFindings,
  lastSeenByOperator,
  listJobHeartbeats,
  findOrganizationBySlug,
  findingScope,
  setFindingDismissal,
  withServingTenant,
  DISMISSAL_HORIZONS,
  DEFAULT_DISMISSAL_HORIZON,
  dismissalHorizon,
} from "@nexus/db";
import { isJobStalled } from "@nexus/shared";
import { OPERATORS } from "../services/operators.js";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";
import { alertTarget } from "../services/alert-dispatch.js";

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
    // DO THESE FINDINGS REACH ANYBODY?
    //
    // The dispatcher shipped this afternoon and is silent until somebody sets
    // OPERATOR_ALERT_WEBHOOK_URL. Nothing said so anywhere, which leaves the
    // page in the one state it was written to avoid: reassuring. A reader sees
    // sixteen operators, a fresh sweep and a short list, and has no way to know
    // whether anybody is told when that list grows at 3am. The measured answer
    // before alerting existed was 4.7 hours for broken-knowledge and sixteen
    // for a knowledge outage.
    //
    // A BOOLEAN, NOT THE URL. The destination is a config value that may carry
    // a token in its path -- Slack's incoming webhooks do -- and this response
    // goes to a browser. Whether it is set is the useful fact; what it is, is
    // not this page's business.
    alertsConfigured: alertTarget() !== null,
    alertsIncludeWarnings: alertTarget()?.alsoWarn ?? false,
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

/**
 * A person accepts a finding, or takes the acceptance back.
 *
 * ============================================================
 * AUTHORISE ON THE BUSINESS, WRITE IN THE OWNER
 * ============================================================
 *
 * A finding about Juris Prime's customer is a ROW UNDER ZIPICKA, because all
 * five firms answer on Zipicka's number and a routed conversation belongs to
 * the number's owner. Juris Prime's staff see it, correctly, because every read
 * resolves through coalesce(serving, owner).
 *
 * The write cannot use the same id. RLS filters on organization_id, so an
 * update run in Juris Prime's transaction matches zero rows AND REPORTS
 * SUCCESS: the button greys out, the finding stays, and nothing says why. That
 * is instance ten of the defect this codebase has met nine times, and it is why
 * `findingScope` returns both ids rather than letting this handler pick one.
 *
 * So: authorise against `businessId`, open the transaction on `organizationId`.
 *
 * WHY DISMISSAL IS NOT DELETION. The row stays and stays reconciled. Deleting
 * it would let the next sweep insert it fresh — first_seen_at = now(), which
 * the reconciler reads as a transition — and the alert dispatcher would tell
 * somebody about a finding they dismissed ten minutes earlier.
 */
async function handleDismissal(
  c: Context,
  by: string | null,
  reason: string | null,
  horizonHours: number | null
) {
  const scope = scopeOf(c);
  // Typed as possibly-undefined because Context is not parameterised on the
  // path here. It cannot actually be absent -- both routes declare :id -- but
  // asserting that with a non-null assertion would hand a literal "undefined"
  // to a uuid column and turn a routing mistake into a 500.
  const findingId = c.req.param("id");
  if (!findingId) return c.json({ error: "Finding not found" }, 404);

  const finding = await findingScope(findingId);
  // Same 404 for "no such finding" and "not yours". A different message would
  // let somebody enumerate which finding ids exist under other businesses.
  const entitled =
    finding !== null &&
    (scope.role === "operator" || finding.businessId === scope.organizationId);
  if (!entitled) return c.json({ error: "Finding not found" }, 404);

  const changed = await withServingTenant(finding.organizationId, () =>
    setFindingDismissal(findingId, by, reason, horizonHours)
  );

  // False means the finding was resolved between the read above and the write
  // — the sweep retracted it while somebody had the page open. Nothing is
  // wrong, but saying "dismissed" would be false.
  if (!changed) {
    return c.json({ error: "That finding was resolved while you were looking at it." }, 409);
  }

  logger.info(
    { sub: scope.sub, findingId, dismissed: by !== null },
    by !== null ? "Finding accepted" : "Finding acceptance withdrawn"
  );
  return c.json({ ok: true });
}

/** The lengths on offer, from the rules themselves rather than typed twice. */
operatorsRoute.get("/dismissal-horizons", (c) => c.json({ horizons: DISMISSAL_HORIZONS }));

operatorsRoute.post("/findings/:id/dismiss", async (c) => {
  const scope = scopeOf(c);
  // Optional and usually absent. Read defensively: this is a browser body.
  let reason: string | null = null;
  let forHow: unknown = DEFAULT_DISMISSAL_HORIZON;
  try {
    const body = (await c.req.json()) as { reason?: unknown; for?: unknown };
    if (typeof body?.reason === "string" && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 500);
    }
    // Absent means the default, which is the middle one. A body that NAMES a
    // length this does not know is a different thing entirely -- the browser
    // and the server disagreeing about the menu -- and is refused rather than
    // quietly turned into the default, which would silence the finding for a
    // length of time nobody chose.
    if (body && "for" in body) forHow = body.for;
  } catch {
    // No body is the normal case.
  }

  const chosen = dismissalHorizon(forHow);
  if ("reason" in chosen) return c.json({ error: chosen.reason }, 400);

  return handleDismissal(c, scope.sub, reason, chosen.horizon.hours);
});

// Withdrawing an acceptance has no length: it clears the end date along with
// everything else, which the writer does under the same null test.
operatorsRoute.post("/findings/:id/restore", async (c) => handleDismissal(c, null, null, null));

