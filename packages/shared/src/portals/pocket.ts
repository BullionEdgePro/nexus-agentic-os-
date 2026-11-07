import type { BoardDeal, BoardUnit } from "../workflows/board.js";

/**
 * Pocket listings (7 Nov 2026): a unit the owner does not want advertised is
 * kept off the portals and shown privately — one link per buyer or tenant on
 * the board. These are the pure rules both sides share: which buyers fit, the
 * message the agent sends, and the WhatsApp link that opens it on their phone.
 * Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §3, §4
 */

/** How long a private link works. */
export const POCKET_SHARE_DAYS = 14;
/** The deal steps a buyer can still be shown a unit on (before the rent/sale deal steps). */
export const POCKET_STEPS = ["D3", "D4", "D5", "D6", "D7"] as const;
/** A budget at least this share of the price "fits". */
const FITS_FROM = 0.9;

/** One private link, as the board shows it — never its token. */
export type PocketShare = {
  id: string;
  dealId: string;
  contactName: string | null;
  sharedBy: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  viewCount: number;
  interestedAt: string | null;
  /** Not revoked and not expired. */
  active: boolean;
};

export type PocketMatch = { deal: BoardDeal; fit: "fits" | "over" | "unknown"; overBy: number | null; shared: boolean };

/**
 * The buyers on the board (the ones this viewer can see) a pocket unit could be
 * shown to: same purpose, on D3–D7. Those whose budget fits come first, the
 * closest to the price first; then those over budget, the smallest gap first;
 * then those whose budget is not known.
 */
export function pocketMatches(unit: BoardUnit, deals: BoardDeal[]): PocketMatch[] {
  const price = unit.priceAed;
  const activeFor = new Set(unit.pocket.shares.filter((s) => s.active).map((s) => s.dealId));
  const rank = { fits: 0, over: 1, unknown: 2 } as const;
  return deals
    .filter((d) => d.purpose === unit.purpose && (POCKET_STEPS as readonly string[]).includes(d.step))
    .map((deal): PocketMatch => {
      const shared = activeFor.has(deal.id);
      if (deal.budgetAed === null || price === null) return { deal, fit: "unknown", overBy: null, shared };
      if (deal.budgetAed >= price * FITS_FROM) return { deal, fit: "fits", overBy: null, shared };
      return { deal, fit: "over", overBy: price - deal.budgetAed, shared };
    })
    .sort((a, b) => {
      if (a.fit !== b.fit) return rank[a.fit] - rank[b.fit];
      if (a.fit === "fits") return Math.abs(a.deal.budgetAed! - price!) - Math.abs(b.deal.budgetAed! - price!);
      if (a.fit === "over") return a.overBy! - b.overBy!;
      return 0;
    });
}

const aed = (n: number) => `AED ${Math.round(n).toLocaleString("en-US")}`;

/** The message the agent sends with the link, from their own WhatsApp. */
export function pocketMessage(p: {
  firstName: string | null;
  title: string;
  community: string;
  priceAed: number;
  url: string;
  agentFirstName: string | null;
  businessName: string;
}): string {
  const hi = p.firstName ? `Hi ${p.firstName},` : "Hi,";
  const from = p.agentFirstName ? `${p.agentFirstName}, ${p.businessName}` : p.businessName;
  return `${hi} a private listing I think fits what you're looking for: ${p.title}, ${p.community}, ${aed(p.priceAed)}. It's off-market, so please keep it to yourself: ${p.url} — ${from}`;
}

/** A link that opens WhatsApp with the text filled in — only for a phone number (6–20 digits). */
export function whatsappLink(number: string | null, text: string): string | null {
  if (!number || /[a-z]/i.test(number)) return null;
  const digits = number.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 20) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}
