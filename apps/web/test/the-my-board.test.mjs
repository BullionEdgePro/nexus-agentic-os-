/**
 * "My board" on My Day (25 Nov 2026): a staff member's own units and deals by
 * step, how many of their units are live on Bayut, and up to five things that
 * need them — a portal that refused a listing, a permit expiring within 14 days
 * (or expired), a viewing today, a card blocked from its next step.
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §4
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { REAL_ESTATE_WORKFLOW } from "@nexus/shared";
import { myBoardSummary } from "@/lib/workflow/my-board";
import { MyBoardView } from "@/app/my-board";

const NOW = Date.parse("2026-11-25T08:00:00Z"); // 12:00 in Dubai
const TZ = "Asia/Dubai";
const ME = { id: "e1", name: "Atif Ali" };
const THEM = { id: "e2", name: "Bilal" };
const off = { wanted: false, state: null };

const unit = (over) => ({
  kind: "unit", id: "u0", step: "S6", inStepSince: "2026-11-20T08:00:00Z", reference: "Unit", community: null,
  propertyType: null, bedrooms: null, purpose: "rent", priceAed: null, cheques: null, ejariReady: false, titleDeed: false,
  ownerDocs: false, formASignedOn: null, permitNumber: null, permitExpiresOn: null, liveOn: [], owner: null, agent: ME,
  notes: null, dealIds: [], updatedAt: "2026-11-20T08:00:00Z", title: null, description: null, sizeSqft: null,
  bathrooms: null, furnishing: null, city: "Dubai", subCommunity: null, building: null, parking: null, amenities: [],
  availableFrom: null, photos: [], portals: { bayut: off, dubizzle: off, property_finder: off }, bayutLocation: null,
  pocket: { on: false, since: null, shares: [] },
  ...over,
});
const deal = (over) => ({
  kind: "deal", id: "d0", step: "D5", inStepSince: "2026-11-20T08:00:00Z", contact: { id: "c1", name: "Ahmed K." },
  purpose: "rent", budgetAed: null, offerAed: null, ejariNumber: null, kycDone: false, formFSignedOn: null,
  dldTransferOn: null, dealValueAed: null, commissionAed: null, agent: ME, notes: null, unitIds: [], nextViewingAt: null,
  ...over,
});
const board = (units, deals = []) => ({
  viewer: { employeeId: "e1", seesAll: false }, units, deals, hidden: {}, hotWaiting: [],
  closed30: { let: 0, sold: 0, won: 0, commissionAed: 0 }, today: "2026-11-25", portalFeed: null, ornSet: true, agentBrns: {},
});
const sum = (b) => myBoardSummary(REAL_ESTATE_WORKFLOW, b, NOW, TZ);

test("counts only my cards, by step in workflow order, leaving out empty steps", () => {
  const s = sum(board(
    [unit({ id: "a", step: "S7" }), unit({ id: "b", step: "S6" }), unit({ id: "c", step: "S6" }), unit({ id: "x", step: "S6", agent: THEM })],
    [deal({ id: "d1", step: "D5" }), deal({ id: "d2", step: "D5", agent: THEM })]
  ));
  assert.deepEqual(s.units.map((r) => [r.step, r.n]), [["S6", 2], ["S7", 1]]);
  assert.deepEqual(s.deals.map((r) => [r.step, r.n]), [["D5", 1]]);
});

test("live on Bayut counts my units whose Bayut listing is live", () => {
  const live = { wanted: true, state: "live" };
  const s = sum(board([unit({ id: "a", portals: { bayut: live, dubizzle: off, property_finder: off } }), unit({ id: "x", agent: THEM, portals: { bayut: live, dubizzle: off, property_finder: off } })]));
  assert.equal(s.liveOnBayut, 1);
});

test("needs me: refused, then permit, then viewing today, then a blocked card — at most five", () => {
  const refused = unit({ id: "r", reference: "Marina 2BR", portals: { bayut: { wanted: true, state: "refused" }, dubizzle: off, property_finder: off } });
  const expiring = unit({ id: "p", reference: "JLT 805", step: "S9", formASignedOn: "2026-01-01", permitNumber: "7", permitExpiresOn: "2026-12-01" });
  const expired = unit({ id: "q", reference: "Palm 12", step: "S9", formASignedOn: "2026-01-01", permitNumber: "7", permitExpiresOn: "2026-11-20" });
  const viewing = deal({ id: "v", nextViewingAt: "2026-11-25T12:00:00Z" });
  const blocked = unit({ id: "b", reference: "Creek 3", step: "S8" });
  const s = sum(board([blocked, refused, expiring, expired], [viewing]));
  assert.deepEqual(s.needsMe.map((n) => n.text), [
    "Marina 2BR — Bayut refused it",
    "JLT 805 — permit expires 1 Dec",
    "Palm 12 — permit expired",
    "Ahmed K. — viewing today 4:00 pm",
    "Creek 3 — Before it can be advertised: Form A signed date, Trakheesi permit number, permit expiry date.",
  ]);
  assert.deepEqual(s.needsMe.map((n) => n.cardId), ["r", "p", "q", "v", "b"]);
  const many = sum(board(Array.from({ length: 8 }, (_, i) => unit({ id: `u${i}`, reference: `U${i}`, step: "S8" }))));
  assert.equal(many.needsMe.length, 5);
});

test("a colleague's card never needs me; a viewer with no employee record owns nothing", () => {
  const theirs = unit({ id: "t", agent: THEM, portals: { bayut: { wanted: true, state: "refused" }, dubizzle: off, property_finder: off } });
  assert.deepEqual(sum(board([theirs])).needsMe, []);
  const nobody = { ...board([unit({ id: "a" })]), viewer: { employeeId: null, seesAll: false } };
  const s = sum(nobody);
  assert.deepEqual([s.units, s.deals, s.needsMe, s.liveOnBayut], [[], [], [], 0]);
});

const render = (props) => renderToStaticMarkup(createElement(MyBoardView, props));

test("the card: my steps, Needs me lines that open the card, and Open board", () => {
  const s = sum(board([unit({ id: "r", reference: "Marina 2BR", portals: { bayut: { wanted: true, state: "refused" }, dubizzle: off, property_finder: off } })]));
  const html = render({ summary: s, error: null });
  assert.match(html, /My board/);
  assert.match(html, /href="\/deck\/workflow\?view=board"[^>]*>Open board →</);
  assert.match(html, /Rent units 1/);
  assert.match(html, /Needs me/);
  assert.match(html, /href="\/deck\/workflow\?card=r"[^>]*>Marina 2BR — Bayut refused it</);
});

test("the card when nothing of mine is on the board, and when it cannot load", () => {
  const empty = sum(board([]));
  assert.match(render({ summary: empty, error: null }), /Nothing of yours on the board/);
  assert.match(render({ summary: null, error: "boom" }), /Could not load your board/);
});
