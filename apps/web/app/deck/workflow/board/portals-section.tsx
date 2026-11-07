"use client";

import {
  PORTAL_TARGETS,
  portalProblems,
  portalProblemSentence,
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
 */

export const PORTAL_LABEL: Record<PortalTarget, string> = {
  bayut: "Bayut",
  dubizzle: "dubizzle",
  property_finder: "Property Finder",
};

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
 * Wanted on a portal AND ready: what Portals + social counts as live (spec §5).
 * A pocket unit is never on a portal: it counts once ready and shared privately
 * by a link that still works (pocket listings, 7 Nov 2026).
 */
export function isPublished(unit: BoardUnit, board: Board): boolean {
  if (unit.pocket?.on) return readiness(unit, board).length === 0 && unit.pocket.shares.some((s) => s.active);
  return Object.values(unit.portals).some((p) => p.wanted) && readiness(unit, board).length === 0;
}

export const POCKET_STAYS_OFF = "A pocket listing stays off the portals — turn Pocket off to publish it.";

/** "10:42, 7 Nov" in the business's own zone. */
function readAt(iso: string, timezone: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone });
  return `${time}, ${day}`;
}

/** What one portal is doing with this unit, in staff's words. */
export function portalState(unit: BoardUnit, portal: PortalTarget, board: Board, timezone: string): string {
  const row = unit.portals[portal];
  if (!row.wanted) return portal === "property_finder" && row.state === "live" ? "Coming off Property Finder" : "Off";
  const problems = readiness(unit, board);
  if (problems.length > 0) return `Off the portals: ${problems[0]}`;
  if (portal === "property_finder") return propertyFinderState(row, board, timezone);
  const at = board.portalFeed?.lastReadAt;
  return at ? `In the feed — Bayut last read it ${readAt(at, timezone)}` : "In the feed — Bayut has not read it yet";
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

export function PortalsSection({
  unit,
  board,
  canEdit,
  timezone,
  onSwitch,
}: {
  unit: BoardUnit;
  board: Board;
  canEdit: boolean;
  timezone: string;
  onSwitch: (portal: PortalTarget, wanted: boolean) => void;
}) {
  const problems = readiness(unit, board);
  const pocket = unit.pocket?.on === true;
  // A pocket unit's switches are locked off; the Pocket section says what it needs.
  const sentence = pocket ? POCKET_STAYS_OFF : portalProblemSentence(problems);
  return (
    <section className="wf-window-part">
      <h3>Portals</h3>
      <ul className="wf-board-portals">
        {PORTAL_TARGETS.map((portal) => {
          const wanted = unit.portals[portal].wanted;
          const state = portalState(unit, portal, board, timezone);
          return (
            <li key={portal} className="wf-board-portal">
              <label className="wf-board-flag">
                <input
                  type="checkbox"
                  role="switch"
                  checked={wanted}
                  disabled={!canEdit || (!wanted && (pocket || problems.length > 0))}
                  onChange={(e) => onSwitch(portal, e.target.checked)}
                />{" "}
                {PORTAL_LABEL[portal]}
              </label>
              <span className={`wf-board-portal-state${/^(Off the portals|Property Finder refused)/.test(state) ? " wf-board-portal-warn" : ""}`}>
                {state}
              </span>
            </li>
          );
        })}
      </ul>
      {sentence ? <p className="wf-board-portal-needs">{sentence}</p> : null}
    </section>
  );
}
