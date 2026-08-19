import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { RaisedFinding } from "@nexus/db";

/**
 * Tell somebody, once, when something becomes wrong.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Sixteen operators sweep the database every ten minutes and they are good at
 * their job. Nothing has ever told anybody what they found. The findings sit on
 * a page, and a page has to be opened.
 *
 * Measured from findings already in the table:
 *
 *   broken-knowledge     stood 4.7 hours on average, 28 times
 *   customer-waiting     stood 10 hours on average
 *   customer-waiting     one URGENT stood 4.5 hours
 *
 * And the two that were not averages: on 18 August a quota failure took 53 of
 * ABR's 72 knowledge passages offline and the finding stood for SIXTEEN HOURS.
 * On 17 August a customer picked a business from the triage menu, received
 * nothing, and waited SEVENTEEN. Both were detected correctly within ten
 * minutes. Neither reached a person.
 *
 * ============================================================
 * WHAT IT SENDS, AND WHAT IT REFUSES TO
 * ============================================================
 *
 * NOT THE FINDING'S TITLE. A title reads "Ahmed has been waiting 3 hours" or
 * "Fatima was promised a colleague 2 days ago and nobody came" — it names a
 * customer, because that is what makes it useful on the deck. This dispatches
 * to a URL somebody pasted into a config file, which may be Slack, a webhook
 * relay, or a service nobody here has audited. A customer's name and their
 * situation are not ours to post there.
 *
 * So the payload is the shape of the problem and where to look at it: which
 * business, which operator, how severe, and a link. The link needs a session,
 * so the detail stays behind the platform's own authentication and the alert is
 * a doorbell rather than a copy of the letter.
 *
 * ============================================================
 * WHEN IT FIRES
 * ============================================================
 *
 * ONLY ON THE TRANSITION. `standing` is the same number on the sweep a problem
 * appears and on the two hundred sweeps after it, so an alert keyed on it says
 * the same thing every ten minutes until somebody mutes the channel — which
 * ends with the channel muted on the day it matters. `reconcileFindings`
 * reports what BECAME true, and only that is dispatched.
 *
 * URGENT ONLY, by default. A warning that a customer has waited two hours is
 * worth a page; it is not worth a phone buzzing at 3am. `ALERT_ON_WARN=true`
 * widens it for anyone who disagrees, which is a preference rather than a
 * correctness question.
 *
 * OFF UNLESS CONFIGURED. With no URL set this does nothing at all, which is
 * exactly the behaviour the platform had before it existed. Nothing leaves this
 * machine until somebody deliberately says where to.
 */

/** Long enough for a slow relay, short enough that a sweep is never held up. */
const TIMEOUT_MS = 4000;

export interface AlertTarget {
  url: string;
  alsoWarn: boolean;
  deckUrl: string;
}

export function alertTarget(): AlertTarget | null {
  const url = env.operatorAlertWebhookUrl;
  if (!url) return null;
  return {
    url,
    alsoWarn: env.operatorAlertOnWarn,
    deckUrl: env.webOrigins[0] ?? "",
  };
}

/**
 * One line a human reads, assembled from what is safe to send.
 *
 * Grouped by business and operator rather than one message per finding: eight
 * knowledge sources breaking at once is one problem, and eight notifications is
 * how somebody learns to swipe them away.
 */
function summarise(findings: RaisedFinding[], slugOf: (id: string) => string): string[] {
  const groups = new Map<string, { severity: string; n: number }>();
  for (const f of findings) {
    // The business being SERVED, not the one that owns the number — an alert
    // sent to the wrong firm is worse than none, because it trains them to
    // ignore the next one. See migration 053.
    const business = slugOf(f.servingOrganizationId ?? f.organizationId);
    const key = `${business}|${f.operator}|${f.severity}`;
    const existing = groups.get(key);
    groups.set(key, { severity: f.severity, n: (existing?.n ?? 0) + 1 });
  }

  return [...groups.entries()].map(([key, { severity, n }]) => {
    const [business, operator] = key.split("|");
    const count = n === 1 ? "" : ` (${n})`;
    return `${severity.toUpperCase()}: ${operator}${count} — ${business}`;
  });
}

/**
 * Post the alert. Never throws, never blocks the sweep for long.
 *
 * A failure here is logged and dropped: the finding is already recorded and
 * visible on the deck, so a dead webhook must not become a reason the sweep
 * stops running. That trade is the whole reason this is best-effort — the
 * monitoring is the database, and this is only its doorbell.
 */
export async function dispatchRaisedFindings(
  findings: RaisedFinding[],
  slugOf: (id: string) => string
): Promise<void> {
  const target = alertTarget();
  if (!target) return;

  const worth = findings.filter(
    (f) => f.severity === "urgent" || (target.alsoWarn && f.severity === "warn")
  );
  if (worth.length === 0) return;

  const lines = summarise(worth, slugOf);
  const body = {
    // Plain `text` because that is what Slack, Discord and most relays read
    // without configuration. The structured fields sit alongside for anything
    // that wants them.
    text: [`Nexus — ${lines.length === 1 ? "a problem" : `${lines.length} problems`} just started`, ...lines, target.deckUrl ? `${target.deckUrl}/deck/operators` : ""]
      .filter(Boolean)
      .join("\n"),
    source: "nexus-operators",
    raised: lines,
    // Deliberately absent: title, detail, subject, customer name, message body.
    deck: target.deckUrl ? `${target.deckUrl}/deck/operators` : null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(
        { status: response.status, alerts: lines.length },
        "Operator alert webhook refused the post — the findings are still on the deck"
      );
      return;
    }
    logger.info({ alerts: lines.length }, "Operator alert dispatched");
  } catch (err) {
    logger.warn(
      { err, alerts: lines.length },
      "Could not reach the operator alert webhook — the findings are still on the deck"
    );
  } finally {
    clearTimeout(timer);
  }
}
