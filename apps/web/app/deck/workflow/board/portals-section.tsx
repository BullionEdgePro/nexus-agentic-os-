"use client";

import {
  BAYUT_PORTALS,
  bayutProblems,
  bayutPublishAwaited,
  PORTAL_TARGETS,
  portalProblems,
  portalProblemSentence,
  type BayutPortal,
  type Board,
  type BoardUnit,
  type PortalTarget,
} from "@nexus/shared";

/**
 * A unit's Portals section (7 Nov 2026): one switch per portal, what each is
 * doing in words, and — when the unit is not ready — what it still needs. It
 * asks the same rule the server refuses with, so it never offers a switch the
 * server would refuse; a switch already on can always be turned off.
 * Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §4, §5, §8
 *
 * Bayut and dubizzle (23 Nov 2026): their lines say where the unit stands with
 * Bayut's API (the feed's lines are gone), their switches ask Bayut's own rule
 * too, and switching one on asks first, because it spends Bayut credits.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §8, §11
 */

export const PORTAL_LABEL: Record<PortalTarget, string> = {
  bayut: "Bayut",
  dubizzle: "dubizzle",
  property_finder: "Property Finder",
};

const isBayutPortal = (portal: PortalTarget): portal is BayutPortal => (BAYUT_PORTALS as readonly PortalTarget[]).includes(portal);

/** What the unit still needs before it can go on the portals (the board knows only whether licences are on file). */
export function readiness(unit: BoardUnit, board: Board): string[] {
  return portalProblems(unit, {
    today: board.today,
    orn: board.ornSet ? "on file" : null,
    agentBrn: unit.agent && board.agentBrns?.[unit.agent.id] ? "on file" : null,
    agentActive: unit.agent ? !(board.agentsGone ?? []).includes(unit.agent.id) : true,
    photoCount: unit.photos.length,
  });
}

/**
 * What Bayut and dubizzle need besides (23 Nov 2026), as the server's rule
 * asks it: the board knows whether a token is saved and whether the card's
 * agent is linked, not to whom — so a linked agent stands in as user 0.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §8
 */
function bayutReadiness(unit: BoardUnit, board: Board): string[] {
  return bayutProblems(unit, {
    tokenSaved: (board.bayutConnection ?? "none") !== "none",
    locationId: unit.bayutLocation?.id ?? null,
    userId: unit.agent && board.bayutLinked?.[unit.agent.id] ? 0 : null,
  });
}

/** What this unit still needs for one portal: the portals' rule, then Bayut's own for Bayut and dubizzle. */
export function portalReadiness(unit: BoardUnit, board: Board, portal: PortalTarget): string[] {
  const problems = readiness(unit, board);
  return isBayutPortal(portal) ? [...problems, ...bayutReadiness(unit, board)] : problems;
}

/**
 * Wanted on a portal AND ready for it: what Portals + social counts as live
 * (spec §5) — for Bayut and dubizzle, by Bayut's rule too (23 Nov 2026), and
 * only once Bayut shows the listing live (final review, 24 Nov 2026): sent,
 * pending, refused or failed is not live, and staff must not be told it is.
 * Property Finder keeps its meaning. The card and the S10 checklist are the
 * only callers; the feed, pocket listings and Property Finder never ask this.
 * A pocket unit is never on a portal: it counts once ready and shared privately
 * by a link that still works (pocket listings, 7 Nov 2026).
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §11
 */
export function isPublished(unit: BoardUnit, board: Board): boolean {
  if (unit.pocket?.on) return readiness(unit, board).length === 0 && unit.pocket.shares.some((s) => s.active);
  return PORTAL_TARGETS.some((portal) => {
    const row = unit.portals[portal];
    if (!row?.wanted || portalReadiness(unit, board, portal).length > 0) return false;
    return !isBayutPortal(portal) || row.state === "live";
  });
}

export const POCKET_STAYS_OFF = "A pocket listing stays off the portals — turn Pocket off to publish it.";

/** "10:42, 7 Nov" in the business's own zone. */
function readAt(iso: string, timezone: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  return `${time}, ${dayOf(iso, timezone)}`;
}

/** "23 Nov" in the business's own zone. */
function dayOf(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone });
}

/** What one portal is doing with this unit, in staff's words. `now` is for Bayut's 24-hour guard. */
export function portalState(unit: BoardUnit, portal: PortalTarget, board: Board, timezone: string, now: number = Date.now()): string {
  if (isBayutPortal(portal)) return bayutState(unit, portal, board, timezone, now);
  const row = unit.portals[portal];
  if (!row.wanted) return row.state === "live" ? "Coming off Property Finder" : "Off";
  const problems = readiness(unit, board);
  if (problems.length > 0) return `Off the portals: ${problems[0]}`;
  return propertyFinderState(row, board, timezone);
}

/**
 * Property Finder, for a unit wanted there and ready (7 Nov 2026): first where
 * the business stands with Property Finder, then Property Finder's own answer.
 * Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §6
 */
function propertyFinderState(row: BoardUnit["portals"]["property_finder"], board: Board, timezone: string): string {
  const connection = board.pfConnection ?? "none";
  if (connection === "none") return "Waiting for the Property Finder connection";
  if (connection === "key-refused") return "Property Finder refused the key — an admin can check it in Portal settings";
  if (connection === "check-failed") return "Property Finder could not be reached to check the key — an admin can check it again in Portal settings";
  if (connection === "waiting-format") return "Key saved — waiting for Property Finder's listing format";
  if (row.state === "live") return row.syncedAt ? `Live on Property Finder — updated ${readAt(row.syncedAt, timezone)}` : "Live on Property Finder";
  if (row.state === "refused") return `Property Finder refused it: ${row.message ?? "no reason given"}`;
  if (row.state === "failed") return "Could not reach Property Finder — trying again";
  return "Sending to Property Finder…";
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** The sync's words when Bayut took a portal down and its switch was turned off (spec §9 rule 9). */
const TAKEN_OFF = "Bayut took it off on ";
const BAYUT_CONNECTION_REMOVED = "Bayut connection removed — listings already on Bayut stay until removed in Profolio";

/**
 * Bayut and dubizzle (23 Nov 2026): the first row of the table that applies.
 * A dubizzle line says dubizzle wherever it names where the listing is (on,
 * off, sent to); it says Bayut where it names Bayut itself — the one
 * connection and token both portals share, Bayut's checks and answers, and
 * reaching Bayut. After Disconnect a listing already on Bayut stays there, so
 * its line says so rather than "Coming off" or "Waiting" (ruling 2). A check
 * that could not reach Bayut is not a refused token: it says so, as Property
 * Finder's does. A draft with a publish behind it reads exactly as pending
 * (final review, 24 Nov 2026): the rule waits for it, never asks again, so the
 * card never says Nexus tries again (`bayutPublishAwaited`, shared with the rule).
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §8, §9, §11
 */
function bayutState(unit: BoardUnit, portal: BayutPortal, board: Board, timezone: string, now: number): string {
  const row = unit.portals[portal];
  const where = PORTAL_LABEL[portal];
  const connection = board.bayutConnection ?? "none";
  const awaited = bayutPublishAwaited(row);
  const onBayut = row.state === "live" || awaited;
  if (!row.wanted && row.state === "unpublished" && row.message?.startsWith(TAKEN_OFF)) {
    return `Off — ${row.message}. Tick to publish again (uses credits).`;
  }
  if (!row.wanted && !onBayut && row.state !== "draft") return "Off";
  if (connection === "none" && onBayut) return BAYUT_CONNECTION_REMOVED;
  if (!row.wanted) return `Coming off ${where}`;
  const problems = portalReadiness(unit, board, portal);
  if (problems.length > 0) return `Off the portals: ${problems[0]}`;
  if (connection === "none") return "Waiting for the Bayut connection";
  if (connection === "token-refused") return "Bayut refused the token — an admin can check it in Portal settings";
  if (connection === "check-failed") return "Bayut could not be reached to check the token — an admin can check it again in Portal settings";
  if (row.state === "refused") return `Bayut refused it: ${row.message ?? "no reason given"}`;
  if (awaited) {
    if (row.permitComment) return `Waiting for Bayut's permit check — ${row.permitComment}`;
    return `Sent to ${where}${row.publishedAt ? ` ${dayOf(row.publishedAt, timezone)}` : ""} — waiting for Bayut to publish it`;
  }
  if (row.state === "live") {
    if (row.message) return `Live on ${where}, but Bayut refused the last change: ${row.message}`;
    return `Live on ${where}${row.syncedAt ? ` — checked ${readAt(row.syncedAt, timezone)}` : ""}. Edit it here, not in Profolio.`;
  }
  if (row.state === "failed") return "Could not reach Bayut — trying again";
  const asked = row.publishedAt ? Date.parse(row.publishedAt) : Number.NaN;
  if (now - asked < DAY_MS) return `Published less than a day ago — Nexus tries again ${readAt(new Date(asked + DAY_MS).toISOString(), timezone)}`;
  return `Sending to ${where}…`;
}

/**
 * What a switch asks before it goes on: Bayut and dubizzle spend SFS's Bayut
 * credits, and a unit already listed through Profolio would be listed twice.
 * Null for a portal that asks nothing.
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §11
 */
export function switchOnConfirm(portal: PortalTarget): string | null {
  if (!isBayutPortal(portal)) return null;
  const where = PORTAL_LABEL[portal];
  return `Publishing on ${where} uses Bayut credits from SFS's account. If this unit is already on ${where} through Profolio, remove it there first.`;
}

const WARN = /^(Off the portals|Property Finder refused|Bayut refused|Bayut could not)|, but Bayut refused/;

export function PortalsSection({
  unit,
  board,
  canEdit,
  timezone,
  now,
  onSwitch,
}: {
  unit: BoardUnit;
  board: Board;
  canEdit: boolean;
  timezone: string;
  /** The board's clock, for Bayut's 24-hour guard. */
  now?: number;
  onSwitch: (portal: PortalTarget, wanted: boolean) => void;
}) {
  const problems = readiness(unit, board);
  const bayutNeeds = bayutReadiness(unit, board);
  const pocket = unit.pocket?.on === true;
  // A pocket unit's switches are locked off; the Pocket section says what it needs.
  const sentence = pocket ? POCKET_STAYS_OFF : portalProblemSentence(problems);
  const bayutSentence = pocket ? null : portalProblemSentence(bayutNeeds, "Before it can go on Bayut and dubizzle");
  return (
    <section className="wf-window-part">
      <h3>Portals</h3>
      <ul className="wf-board-portals">
        {PORTAL_TARGETS.map((portal) => {
          const wanted = unit.portals[portal].wanted;
          const state = portalState(unit, portal, board, timezone, now);
          return (
            <li key={portal} className="wf-board-portal">
              <label className="wf-board-flag">
                <input
                  type="checkbox"
                  role="switch"
                  checked={wanted}
                  disabled={!canEdit || (!wanted && (pocket || portalReadiness(unit, board, portal).length > 0))}
                  onChange={(e) => {
                    const on = e.target.checked;
                    const ask = on ? switchOnConfirm(portal) : null;
                    if (ask && !window.confirm(ask)) return;
                    onSwitch(portal, on);
                  }}
                />{" "}
                {PORTAL_LABEL[portal]}
              </label>
              <span className={`wf-board-portal-state${WARN.test(state) ? " wf-board-portal-warn" : ""}`}>{state}</span>
            </li>
          );
        })}
      </ul>
      {sentence ? <p className="wf-board-portal-needs">{sentence}</p> : null}
      {bayutSentence ? <p className="wf-board-portal-needs">{bayutSentence}</p> : null}
    </section>
  );
}
