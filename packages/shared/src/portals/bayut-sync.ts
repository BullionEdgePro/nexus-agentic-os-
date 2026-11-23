import { BAYUT_PORTALS, type BayutPortal } from "./bayut-listing.js";

/**
 * Bayut and dubizzle sync (23 Nov 2026): what to do next for one unit.
 *
 * Pure. `should.portals` is the portals wanted AND ready, decided when the job
 * runs, never stored. What Bayut holds is described by its property reference,
 * a fingerprint of the listing as last sent, and each portal's last answer. A
 * publish costs credits, so it is asked once and then waited for, a refusal
 * waits for the listing to change, and no portal is published twice in 24 hours.
 * Rule 9 (a portal Bayut took down is switched off) belongs to the job, not here.
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §9
 */

export type BayutState = "draft" | "pending" | "live" | "unpublished" | "refused" | "failed";

export type BayutRemote = {
  ref: string | null;
  fingerprint: string | null;
  portals: Record<BayutPortal, { state: BayutState | null; publishedAt: string | null }>;
};

export type BayutStep =
  | { kind: "create" }
  | { kind: "update" }
  | { kind: "publish"; portals: BayutPortal[] }
  | { kind: "remove"; portals: BayutPortal[] };

/** Where a business stands with Bayut, for the board. "check-failed": Bayut could not be reached, not a refusal. */
export type BayutConnection = "none" | "token-refused" | "check-failed" | "connected";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A publish was asked and Bayut has not made it live: `pending`, or a `draft`
 * with a publish behind it (Bayut showed a listing it had, or was asked to
 * publish, as a draft). Waited for, never asked again (rule 7) — the rule and
 * the card both ask this, so the card never promises a publish the rule does
 * not make (final review, 24 Nov 2026).
 */
export function bayutPublishAwaited(portal: { state: string | null; publishedAt: string | null }): boolean {
  return portal.state === "pending" || (portal.state === "draft" && portal.publishedAt !== null);
}

export function bayutNextSteps(
  should: { portals: BayutPortal[]; fingerprint: string | null },
  remote: BayutRemote,
  now: Date,
): BayutStep[] {
  const steps: BayutStep[] = [];
  const wanted = BAYUT_PORTALS.filter((p) => should.portals.includes(p));

  // 1. Anything Bayut may still advertise (or is checking) that is no longer wanted comes off.
  if (remote.ref) {
    const remove = BAYUT_PORTALS.filter((p) => {
      const state = remote.portals[p].state;
      return !wanted.includes(p) && state !== null && state !== "unpublished";
    });
    if (remove.length) steps.push({ kind: "remove", portals: remove });
  }

  // 2. Nothing should be live: only step 1.
  if (wanted.length === 0) return steps;

  const changed = should.fingerprint !== remote.fingerprint;
  const sendable = (p: BayutPortal): boolean => {
    const { state, publishedAt } = remote.portals[p];
    // 8. Credit guard: never published twice within 24 hours.
    if (publishedAt && now.getTime() - Date.parse(publishedAt) < DAY_MS) return false;
    // 7. Pending, and a draft that has a publish behind it, are waited for.
    if (bayutPublishAwaited(remote.portals[p])) return false;
    // A draft never published is ready.
    if (state === null || state === "unpublished" || state === "failed" || state === "draft") return true;
    // 3. A refusal waits for the listing to change.
    if (state === "refused") return changed;
    return false; // live
  };
  const toPublish = wanted.filter(sendable);

  if (!remote.ref) {
    // 4. Never sent: create, then publish where wanted.
    steps.push({ kind: "create" });
    if (toPublish.length) steps.push({ kind: "publish", portals: toPublish });
    return steps;
  }

  // 5 / 6. Sent before: update when the listing changed, then publish what is not live or waiting.
  if (changed) steps.push({ kind: "update" });
  if (toPublish.length) steps.push({ kind: "publish", portals: toPublish });
  return steps;
}
