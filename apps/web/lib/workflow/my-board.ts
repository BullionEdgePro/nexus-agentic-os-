import { boardColumns, moveProblem, type Board, type BoardCard, type Workflow } from "@nexus/shared";
import { cardTitle } from "@/app/deck/workflow/board/board-card";
import { isMine } from "./board-layout";

/**
 * "My board" on My Day (25 Nov 2026): a staff member's own cards on the
 * Workflow Board, counted by step, and up to five things that need them, most
 * urgent first — a portal that refused a listing, a permit expiring within 14
 * days (or expired), a viewing today, a unit that cannot move on to its next
 * step. Pure, so it can be tested; the card on My Day only draws it.
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §4
 */

export type MyBoardSummary = {
  units: { step: string; name: string; n: number }[];
  deals: { step: string; name: string; n: number }[];
  liveOnBayut: number;
  needsMe: { cardId: string; text: string }[];
};

const NEEDS_MAX = 5;
const PERMIT_WARN_DAYS = 14;
const PORTAL_NAME = { bayut: "Bayut", dubizzle: "dubizzle", property_finder: "Property Finder" } as const;

/** Where a unit goes next when it is ready: both kinds of unit go to Compliance, then listing, then the portals. */
const UNIT_NEXT: Record<string, string> = { S6: "S8", S7: "S8", S8: "S9", S9: "S10" };

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
const dayMonth = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayIn = (iso: string, timezone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(iso));
const timeIn = (iso: string, timezone: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: timezone });

/** The one reason a card needs its agent, with its rank (lower first), or null. */
function need(card: BoardCard, board: Board, timezone: string): { rank: number; text: string } | null {
  const title = cardTitle(card);
  if (card.kind === "unit") {
    const refused = (Object.keys(PORTAL_NAME) as (keyof typeof PORTAL_NAME)[]).find(
      (p) => card.portals[p]?.wanted && card.portals[p]?.state === "refused"
    );
    if (refused) return { rank: 0, text: `${title} — ${PORTAL_NAME[refused]} refused it` };
    if (card.permitExpiresOn) {
      const left = days(board.today, card.permitExpiresOn);
      if (left < 0) return { rank: 1, text: `${title} — permit expired` };
      if (left <= PERMIT_WARN_DAYS) return { rank: 1, text: `${title} — permit expires ${dayMonth(card.permitExpiresOn)}` };
    }
    const next = UNIT_NEXT[card.step];
    const blocked = next ? moveProblem(card, next, board.today) : null;
    if (blocked) return { rank: 3, text: `${title} — ${blocked}` };
    return null;
  }
  if (card.nextViewingAt && dayIn(card.nextViewingAt, timezone) === board.today) {
    return { rank: 2, text: `${title} — viewing today ${timeIn(card.nextViewingAt, timezone)}` };
  }
  return null;
}

export function myBoardSummary(workflow: Workflow, board: Board, _now: number, timezone: string): MyBoardSummary {
  const mine = (c: BoardCard) => isMine(c, board.viewer);
  const units = board.units.filter(mine);
  const deals = board.deals.filter(mine);
  const byStep = (lane: "supply" | "demand", cards: BoardCard[]) =>
    boardColumns(workflow, lane)
      .map((s) => ({ step: s.id, name: s.name, n: cards.filter((c) => c.step === s.id).length }))
      .filter((r) => r.n > 0);
  const needsMe = [...units, ...deals]
    .map((card) => ({ card, need: need(card, board, timezone) }))
    .filter((x): x is { card: BoardCard; need: { rank: number; text: string } } => x.need !== null)
    .sort((a, b) => a.need.rank - b.need.rank)
    .slice(0, NEEDS_MAX)
    .map(({ card, need: n }) => ({ cardId: card.id, text: n.text }));
  return {
    units: byStep("supply", units),
    deals: byStep("demand", deals),
    liveOnBayut: units.filter((u) => u.portals.bayut?.state === "live").length,
    needsMe,
  };
}
