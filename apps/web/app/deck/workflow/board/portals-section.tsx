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
    photoCount: unit.photos.length,
  });
}

/** "10:42, 7 Nov" in the business's own zone. */
function readAt(iso: string, timezone: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: timezone });
  const day = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: timezone });
  return `${time}, ${day}`;
}

/** What one portal is doing with this unit, in staff's words. */
export function portalState(unit: BoardUnit, portal: PortalTarget, board: Board, timezone: string): string {
  if (!unit.portals[portal].wanted) return "Off";
  const problems = readiness(unit, board);
  if (problems.length > 0) return `Off the portals: ${problems[0]}`;
  if (portal === "property_finder") return "Waiting for the Property Finder connection";
  const at = board.portalFeed?.lastReadAt;
  return at ? `In the feed — Bayut last read it ${readAt(at, timezone)}` : "In the feed — Bayut has not read it yet";
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
  const sentence = portalProblemSentence(problems);
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
                  disabled={!canEdit || (!wanted && problems.length > 0)}
                  onChange={(e) => onSwitch(portal, e.target.checked)}
                />{" "}
                {PORTAL_LABEL[portal]}
              </label>
              <span className={`wf-board-portal-state${state.startsWith("Off the portals") ? " wf-board-portal-warn" : ""}`}>{state}</span>
            </li>
          );
        })}
      </ul>
      {sentence ? <p className="wf-board-portal-needs">{sentence}</p> : null}
    </section>
  );
}
