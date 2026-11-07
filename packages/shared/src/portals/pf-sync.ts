/**
 * Property Finder sync (7 Nov 2026): what to do next for one unit.
 *
 * A unit should be live on Property Finder when it is wanted there AND ready —
 * the same rule as the Bayut/dubizzle feed, decided when the job runs, never
 * stored. What Property Finder holds is described by its reference, its last
 * answer and a fingerprint of the listing as it was last sent, so a save that
 * changes nothing sends nothing, and a refusal waits until the listing changes
 * (sending the same thing again would only be refused again).
 *
 * Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §5
 */

/**
 * Off until Property Finder's listing format is known. Its documentation is
 * behind a password only someone inside PF Expert can open, so the four listing
 * calls are not written yet; while this is false nothing is sent to Property
 * Finder's listing API and the card says it is waiting for the format.
 */
export const PF_LISTING_CALLS_READY: boolean = false;

export type PfState = "live" | "unpublished" | "refused" | "failed";
export type PfRemote = { ref: string | null; state: PfState | null; fingerprint: string | null };
export type PfStep = "create" | "update" | "publish" | "unpublish" | "none";

/**
 * Where a business stands with Property Finder, for the board. "check-failed":
 * the last check could not reach Property Finder — not a refusal (final review).
 */
export type PfConnection = "none" | "key-refused" | "check-failed" | "waiting-format" | "connected";

export function pfNextStep(should: { live: boolean; fingerprint: string | null }, remote: PfRemote): PfStep {
  // A listing Property Finder has not taken down may still be advertised — even
  // when its last change was refused or failed (final review) — so it comes off.
  if (!should.live) return remote.ref && remote.state !== "unpublished" ? "unpublish" : "none";
  const changed = should.fingerprint !== remote.fingerprint;
  if (remote.state === "refused" && !changed) return "none";
  if (!remote.ref) return "create";
  if (changed) return "update";
  return remote.state === "live" ? "none" : "publish";
}
