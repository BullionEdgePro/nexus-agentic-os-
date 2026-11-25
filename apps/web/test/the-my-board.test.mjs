/**
 * "My board" on My Day (25 Nov 2026): a staff member's own units and deals by
 * step, how many of their units are live on Bayut, and up to five things that
 * need them, most urgent first (final review) — a viewing today, a permit that
 * has expired, a portal that refused a listing, a permit expiring within 14
 * days, then a card blocked from its next step or wanted on a portal but not
 * ready ("Off the portals: …") — and how many more wait on the board.
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §4
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { REAL_ESTATE_WORKFLOW } from "@nexus/shared";
import { myBoardSummary } from "@/lib/workflow/my-board";
import { MyBoardView } from "@/app/my-board";
import { portalState } from "@/app/deck/workflow/board/portals-section";

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

// A unit ready for every portal (final review, 25 Nov 2026): nothing in portalProblems or bayutProblems.
const ROW = { wanted: false, state: null, message: null, syncedAt: null, permitComment: null, publishedAt: null };
const PHOTOS = ["p1", "p2", "p3"].map((id) => ({ id, width: 2048, height: 1536 }));
const ready = (over) => unit({
  step: "S10", reference: "Marina Gate 2BR", community: "Dubai Marina", propertyType: "apartment", bedrooms: 2, bathrooms: 2,
  priceAed: 150000, sizeSqft: 1200, title: "Bright 2-bed with marina view",
  description: "A bright two-bedroom apartment on a high floor, with a balcony over the marina.", photos: PHOTOS,
  formASignedOn: "2026-10-28", permitNumber: "71450", permitExpiresOn: "2027-10-27",
  bayutLocation: { id: 5002, name: "UAE › Dubai › Dubai Marina" }, portals: { bayut: ROW, dubizzle: ROW, property_finder: ROW },
  ...over,
});
/** The three portal rows with `portal` switched on. */
const on = (portal, row = {}) => ({ bayut: ROW, dubizzle: ROW, property_finder: ROW, [portal]: { ...ROW, wanted: true, ...row } });
/** A board that knows my BRN and my Bayut user, with Bayut connected. */
const listed = (units, deals = [], over = {}) => ({
  ...board(units, deals), agentBrns: { e1: true }, agentsGone: [], pfConnection: "none", bayutConnection: "connected", bayutLinked: { e1: true }, ...over,
});

test("live on Bayut counts my units the board shows live there: wanted, ready and live (isPublished's rule)", () => {
  const live = ready({ id: "a", portals: on("bayut", { state: "live" }) });
  const count = (u, over) => sum(listed([u], [], over)).liveOnBayut;
  assert.equal(count(live), 1);
  assert.equal(count({ ...live, agent: THEM }), 0, "a colleague's");
  assert.equal(count({ ...live, portals: { ...live.portals, bayut: { ...ROW, state: "live" } } }), 0, "coming off Bayut");
  assert.equal(count({ ...live, photos: [] }), 0, "not ready");
  assert.equal(count({ ...live, bayutLocation: null }), 0, "not ready for Bayut");
  assert.equal(count({ ...live, permitExpiresOn: "2026-11-20" }), 0, "permit expired");
  assert.equal(count(ready({ id: "a", portals: on("bayut", { state: "pending", publishedAt: "2026-11-24T08:00:00Z" }) })), 0, "sent, not live yet");
  assert.equal(count(ready({ id: "a", portals: on("property_finder", { state: "live" }) })), 0, "on Property Finder only");
  assert.equal(count(ready({ id: "a", portals: on("dubizzle", { state: "live" }) })), 0, "on dubizzle only");
});

test("needs me, most urgent first: a viewing today, an expired permit, a refused listing, an expiring permit, then a blocked card", () => {
  const refused = unit({ id: "r", reference: "Marina 2BR", portals: { bayut: { wanted: true, state: "refused" }, dubizzle: off, property_finder: off } });
  const expiring = unit({ id: "p", reference: "JLT 805", step: "S9", formASignedOn: "2026-01-01", permitNumber: "7", permitExpiresOn: "2026-12-01" });
  const expired = unit({ id: "q", reference: "Palm 12", step: "S9", formASignedOn: "2026-01-01", permitNumber: "7", permitExpiresOn: "2026-11-20" });
  const viewing = deal({ id: "v", nextViewingAt: "2026-11-25T12:00:00Z" });
  const blocked = unit({ id: "b", reference: "Creek 3", step: "S8" });
  const s = sum(board([blocked, refused, expiring, expired], [viewing]));
  assert.deepEqual(s.needsMe.map((n) => n.text), [
    "Ahmed K. — viewing today 4:00 pm",
    "Palm 12 — permit expired",
    "Marina 2BR — Bayut refused it",
    "JLT 805 — permit expires 1 Dec",
    "Creek 3 — Before it can be advertised: Form A signed date, Trakheesi permit number, permit expiry date.",
  ]);
  assert.deepEqual(s.needsMe.map((n) => n.cardId), ["v", "q", "r", "p", "b"]);
  // One line per card, its most urgent: a refused unit whose permit has expired says the permit.
  const both = unit({ id: "z", reference: "Both", permitExpiresOn: "2026-11-01", portals: { bayut: { wanted: true, state: "refused" }, dubizzle: off, property_finder: off } });
  assert.deepEqual(sum(board([both])).needsMe.map((n) => n.text), ["Both — permit expired"]);
});

test("needs me: permits never push today's viewing off; within a kind, the most urgent first", () => {
  const permit = (id, on) => unit({ id, reference: id, step: "S9", formASignedOn: "2026-01-01", permitNumber: "7", permitExpiresOn: on });
  const viewing = deal({ id: "v", nextViewingAt: "2026-11-25T12:00:00Z" });
  const five = ["2026-12-09", "2026-12-08", "2026-12-07", "2026-12-06", "2026-12-05"].map((d, i) => permit(`P${i}`, d));
  const s = sum(board(five, [viewing]));
  assert.equal(s.needsMe[0].text, "Ahmed K. — viewing today 4:00 pm");
  assert.deepEqual(s.needsMe.slice(1).map((n) => n.cardId), ["P4", "P3", "P2", "P1"]);
  const gone = ["2026-11-24", "2026-11-23", "2026-11-22", "2026-11-21", "2026-11-20"].map((d, i) => permit(`G${i}`, d));
  assert.equal(sum(board(gone, [viewing])).needsMe[0].cardId, "v");
  const mixed = [permit("late", "2026-12-08"), permit("soon", "2026-11-27"), permit("gone2", "2026-11-22"), permit("gone1", "2026-11-10")];
  assert.deepEqual(sum(board(mixed)).needsMe.map((n) => n.cardId), ["gone1", "gone2", "soon", "late"]);
  const sara = deal({ id: "s", contact: { id: "c2", name: "Sara" }, nextViewingAt: "2026-11-25T13:00:00Z" });
  const omar = deal({ id: "o", contact: { id: "c3", name: "Omar" }, nextViewingAt: "2026-11-25T06:00:00Z" });
  assert.deepEqual(sum(board([], [sara, omar])).needsMe.map((n) => n.text), ["Omar — viewing today 10:00 am", "Sara — viewing today 5:00 pm"]);
});

test("needs me shows at most five, and says how many more wait on the board", () => {
  const many = sum(board(Array.from({ length: 8 }, (_, i) => unit({ id: `u${i}`, reference: `U${i}`, step: "S8" }))));
  assert.equal(many.needsMe.length, 5);
  assert.equal(many.needsMore, 3);
  assert.equal(sum(board([unit({ id: "b", reference: "Creek 3", step: "S8" })])).needsMore, 0);
  const html = render({ summary: many, error: null });
  assert.match(html, /href="\/deck\/workflow\?view=board"[^>]*>\+3 more on the board</);
});

test("needs me: a unit wanted on a portal but not ready says what its card says — Off the portals: <first problem>", () => {
  const one = (u, over) => sum(listed([u], [], over)).needsMe.map((n) => n.text);
  const noPhotos = ready({ id: "a", photos: [], portals: on("bayut") });
  assert.deepEqual(one(noPhotos), ["Marina Gate 2BR — Off the portals: 3 photos"]);
  assert.equal(one(noPhotos)[0], `Marina Gate 2BR — ${portalState(noPhotos, "bayut", listed([noPhotos]), TZ, NOW)}`, "the card's own words");
  assert.deepEqual(one(ready({ id: "a", bayutLocation: null, portals: on("dubizzle") })), ["Marina Gate 2BR — Off the portals: the Bayut location"]);
  assert.deepEqual(one(ready({ id: "a", step: "S9", portals: on("bayut") }), { agentBrns: {} }), ["Marina Gate 2BR — Off the portals: the agent's BRN"]);
  // Nothing to say: wanted nowhere, or ready and live.
  assert.deepEqual(one(ready({ id: "a", photos: [] })), []);
  assert.deepEqual(one(ready({ id: "a", portals: on("bayut", { state: "live" }) })), []);
  // The step's own rule speaks first.
  assert.deepEqual(one(ready({ id: "a", step: "S9", permitNumber: null, portals: on("bayut") })), ["Marina Gate 2BR — Before it can be advertised: Trakheesi permit number."]);
});

test("needs me: a permit warns from 14 days out to the day it expires, then says expired", () => {
  const at = (on) => sum(board([unit({ id: "u", reference: "U", step: "S9", formASignedOn: "2026-01-01", permitNumber: "7", permitExpiresOn: on })])).needsMe.map((n) => n.text);
  assert.deepEqual(at("2026-12-10"), []);
  assert.deepEqual(at("2026-12-09"), ["U — permit expires 9 Dec"]);
  assert.deepEqual(at("2026-11-25"), ["U — permit expires 25 Nov"]);
  assert.deepEqual(at("2026-11-24"), ["U — permit expired"]);
});

test("my board asks the board's own permit rule and keeps no 14-day threshold of its own", () => {
  const src = readFileSync(new URL("../lib/workflow/my-board.ts", import.meta.url), "utf8");
  assert.match(src, /permitState\(/);
  assert.doesNotMatch(src, /PERMIT_WARN_DAYS|<=\s*14/);
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
