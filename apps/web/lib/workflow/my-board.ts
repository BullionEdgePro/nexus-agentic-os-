import { boardColumns, moveProblem, permitState, PORTAL_TARGETS, type Board, type BoardCard, type Workflow } from "@nexus/shared";
import { cardTitle } from "@/app/deck/workflow/board/board-card";
import { isPublishedOn, PORTAL_LABEL, portalState } from "@/app/deck/workflow/board/portals-section";
import { isMine } from "./board-layout";

/**
 * "My board" on My Day (25 Nov 2026): a staff member's own cards on the
 * Workflow Board, counted by step; how many of their units are live on Bayut
 * by the board's own rule (wanted, ready and live — isPublished); and up to
 * five things that need them, most urgent first (final review, 25 Nov 2026):
 * a viewing today, earliest first (a customer turns up); a permit that has
 * expired, oldest first (an advert may be breaking the rules); a portal that
 * refused a listing; a permit expiring within 14 days, soonest first; then a
 * unit that cannot move on to its next step, or is wanted on a portal but not
 * ready — in its card's own words ("Off the portals: …"). One line per card,
 * its most urgent; how many more wait on the board is counted, never dropped
 * silently. Pure, so it can be tested; the card on My Day only draws it.
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §4
 */

export type MyBoardSummary = {
  units: { step: string; name: string; n: number }[];
  deals: { step: string; name: string; n: number }[];
  liveOnBayut: number;
  needsMe: { cardId: string; text: string }[];
  /** Lines past the five shown, waiting on the board. */
  needsMore: number;
};

const NEEDS_MAX = 5;

/** Where a unit goes next when it is ready: both kinds of unit go to Compliance, then listing, then the portals. */
const UNIT_NEXT: Record<string, string> = { S6: "S8", S7: "S8", S8: "S9", S9: "S10" };

/** Most urgent first: a customer today, then what is wrong now, then what is coming, then what waits on the agent. */
const RANK = { viewingToday: 0, permitExpired: 1, refused: 2, permitExpiring: 3, blocked: 4 } as const;
/** How the card's Portals section begins a portal's line when the unit is wanted there but not ready. */
const OFF_THE_PORTALS = "Off the portals: ";

/** A card's one reason to need its agent: its rank (lower first), when (earlier first, within a rank), and the words. */
type Need = { rank: number; at: number; text: string };

const dayMonth = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayIn = (iso: string, timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(iso));
const timeIn = (iso: string, timezone: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone });

function need(card: BoardCard, board: Board, timezone: string, now: number): Need | null {
  const title = cardTitle(card);
  if (card.kind === "deal") {
    if (card.nextViewingAt && dayIn(card.nextViewingAt, timezone) === board.today) {
      return { rank: RANK.viewingToday, at: Date.parse(card.nextViewingAt), text: `${title} — viewing today ${timeIn(card.nextViewingAt, timezone)}` };
    }
    return null;
  }
  const permit = permitState(card, board.today);
  const expiresAt = card.permitExpiresOn ? Date.parse(`${card.permitExpiresOn}T00:00:00Z`) : 0;
  if (permit === "expired") return { rank: RANK.permitExpired, at: expiresAt, text: `${title} — permit expired` };
  const refused = PORTAL_TARGETS.find((p) => card.portals[p]?.wanted && card.portals[p]?.state === "refused");
  if (refused) return { rank: RANK.refused, at: 0, text: `${title} — ${PORTAL_LABEL[refused]} refused it` };
  if (permit === "expiring" && card.permitExpiresOn) {
    return { rank: RANK.permitExpiring, at: expiresAt, text: `${title} — permit expires ${dayMonth(card.permitExpiresOn)}` };
  }
  const next = UNIT_NEXT[card.step];
  const blocked = next ? moveProblem(card, next, board.today) : null;
  if (blocked) return { rank: RANK.blocked, at: 0, text: `${title} — ${blocked}` };
  // Wanted on a portal but not ready (spec §4, "the portal readiness line"): the card's own line for that portal.
  const off = PORTAL_TARGETS.filter((p) => card.portals[p]?.wanted)
    .map((p) => portalState(card, p, board, timezone, now))
    .find((line) => line.startsWith(OFF_THE_PORTALS));
  if (off) return { rank: RANK.blocked, at: 0, text: `${title} — ${off}` };
  return null;
}

export function myBoardSummary(workflow: Workflow, board: Board, now: number, timezone: string): MyBoardSummary {
  const mine = (c: BoardCard) => isMine(c, board.viewer);
  const units = board.units.filter(mine);
  const deals = board.deals.filter(mine);
  const byStep = (lane: "supply" | "demand", cards: BoardCard[]) =>
    boardColumns(workflow, lane)
      .map((s) => ({ step: s.id, name: s.name, n: cards.filter((c) => c.step === s.id).length }))
      .filter((r) => r.n > 0);
  // Array sort is stable: within a rank and a time, the board's own order (oldest in its step first).
  const needs = [...units, ...deals]
    .map((card) => ({ card, need: need(card, board, timezone, now) }))
    .filter((x): x is { card: BoardCard; need: Need } => x.need !== null)
    .sort((a, b) => a.need.rank - b.need.rank || a.need.at - b.need.at);
  return {
    units: byStep("supply", units),
    deals: byStep("demand", deals),
    liveOnBayut: units.filter((u) => isPublishedOn(u, board, "bayut")).length,
    needsMe: needs.slice(0, NEEDS_MAX).map(({ card, need: n }) => ({ cardId: card.id, text: n.text })),
    needsMore: Math.max(0, needs.length - NEEDS_MAX),
  };
}
