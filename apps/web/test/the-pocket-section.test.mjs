// Pocket listings on the card (7 Nov 2026): the Pocket switch, the buyers it
// fits, each private link and what happened to it, the window with the message
// to send, the locked portal switches, the badges, and Portals + social done
// when a pocket unit is shared privately.
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §2, §3, §7
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { PocketSection, ShareWindow, shareState, matchLine } from "@/app/deck/workflow/board/pocket-section";
import { PortalsSection, isPublished } from "@/app/deck/workflow/board/portals-section";
import { WorkflowCard } from "@/app/deck/workflow/board/board-card";

const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const noop = () => {};
const TZ = "Asia/Dubai";
const NOW = Date.parse("2026-11-07T08:00:00Z");
const NONE = { state: null, message: null, syncedAt: null };
const OFF = { bayut: { wanted: false, ...NONE }, dubizzle: { wanted: false, ...NONE }, property_finder: { wanted: false, ...NONE } };
const AISHA = { id: "e1", name: "Aisha Khan" };
const POCKET = { on: true, since: "2026-11-06T08:00:00.000Z", shares: [] };
const READY = {
  kind: "unit", id: "u1", step: "S10", inStepSince: "2026-11-01T08:00:00.000Z", updatedAt: "2026-11-06T09:30:00.000Z",
  reference: "Palm villa 12", community: "Palm Jumeirah", propertyType: "villa", bedrooms: 4, purpose: "sale",
  priceAed: 1000000, cheques: null, ejariReady: false, titleDeed: true, ownerDocs: true, formASignedOn: "2026-10-28",
  permitNumber: "71450", permitExpiresOn: "2027-10-27", liveOn: [], owner: null, agent: AISHA, notes: null, dealIds: [],
  title: "Palm villa with beach access", description: "A four-bedroom villa on the Palm with its own stretch of beach and a pool.",
  sizeSqft: 5200, bathrooms: 5, furnishing: "furnished", city: "Dubai", subCommunity: "Frond K", building: "Signature Villas",
  parking: 2, amenities: ["private_pool"], availableFrom: null,
  photos: [{ id: "p1", width: 2048, height: 1536 }, { id: "p2", width: 2048, height: 1536 }, { id: "p3", width: 2048, height: 1536 }],
  portals: OFF, pocket: POCKET,
};
const deal = (id, name, budgetAed, over = {}) => ({
  kind: "deal", id, step: "D5", inStepSince: "2026-11-01T08:00:00.000Z", contact: { id: `c-${id}`, name }, purpose: "sale",
  budgetAed, offerAed: null, ejariNumber: null, kycDone: false, formFSignedOn: null, dldTransferOn: null, dealValueAed: null,
  commissionAed: null, agent: AISHA, notes: null, unitIds: [], nextViewingAt: null, ...over,
});
const DEALS = [deal("d1", "Sara Khan", 950000), deal("d2", "Omar Haddad", 800000), deal("d3", "Rana Ali", null)];
const BOARD = {
  units: [READY], deals: DEALS, hidden: {}, hotWaiting: [], closed30: { let: 0, sold: 0, won: 0, commissionAed: 0 },
  today: "2026-11-07", portalFeed: null, ornSet: true, agentBrns: { e1: true }, agentsGone: [], pfConnection: "none",
};
const share = (over) => ({
  id: "s1", dealId: "d1", contactName: "Sara Khan", sharedBy: "Aisha Khan", createdAt: "2026-11-07T06:00:00.000Z",
  expiresAt: "2026-11-21T06:00:00.000Z", revokedAt: null, firstViewedAt: null, lastViewedAt: null, viewCount: 0,
  interestedAt: null, active: true, ...over,
});
const section = (unit, over = {}) =>
  render(PocketSection, { unit, board: { ...BOARD, units: [unit] }, canEdit: true, timezone: TZ, now: NOW, onSwitch: noop, onShare: noop, onRevoke: noop, ...over });

test("what happened to a link, in the agent's words", () => {
  assert.equal(shareState(share({}), NOW, TZ), "Sent 7 Nov · not opened yet");
  assert.equal(shareState(share({ viewCount: 3, firstViewedAt: "2026-11-07T06:30:00.000Z", lastViewedAt: "2026-11-07T06:42:00.000Z" }), NOW, TZ), "Opened 3× · last 10:42, 7 Nov");
  assert.equal(shareState(share({ viewCount: 1, lastViewedAt: "2026-11-07T06:42:00.000Z", interestedAt: "2026-11-07T06:45:00.000Z" }), NOW, TZ), "Interested 10:45, 7 Nov");
  assert.equal(shareState(share({ active: false, expiresAt: "2026-11-06T06:00:00.000Z" }), NOW, TZ), "Expired 6 Nov");
  assert.equal(shareState(share({ active: false, revokedAt: "2026-11-07T07:00:00.000Z" }), NOW, TZ), "Revoked");
});

test("how a buyer fits, in a few words", () => {
  assert.equal(matchLine({ fit: "fits", overBy: null, shared: false }), "Fits the budget");
  assert.equal(matchLine({ fit: "over", overBy: 200000, shared: false }), "Over budget by AED 200,000");
  assert.equal(matchLine({ fit: "unknown", overBy: null, shared: false }), "Budget not known");
});

test("off: the switch and what it means, nothing to share", () => {
  const html = section({ ...READY, pocket: { on: false, since: null, shares: [] } });
  assert.match(html, /<h3>Pocket<\/h3>/);
  assert.match(html, /Pocket listing/);
  assert.match(html, /Off-market: shared privately, never on the portals\./);
  assert.doesNotMatch(html, /Share privately/);
});

test("on and ready: the buyers who fit, best first, each with Share", () => {
  const html = section({ ...READY, pocket: { ...POCKET, shares: [share({ dealId: "d3", contactName: "Rana Ali" })] } });
  assert.match(html, /Share privately/);
  const sara = html.indexOf("Sara Khan · Fits the budget");
  const omar = html.indexOf("Omar Haddad · Over budget by AED 200,000");
  const rana = html.indexOf("Rana Ali · Budget not known · Shared");
  assert.ok(sara > 0 && omar > sara && rana > omar, html);
  assert.equal((html.match(/>Share</g) ?? []).length, 2, "no Share for a buyer already holding a link");
});

test("on but not ready: what it still needs", () => {
  const html = section({ ...READY, permitExpiresOn: "2026-11-01" });
  assert.match(html, /Before it can be shared: a permit that has not expired\./);
  assert.doesNotMatch(html, />Share</);
});

test("each link with its state; only a working one can be revoked", () => {
  const shares = [
    share({ id: "s1", viewCount: 2, lastViewedAt: "2026-11-07T06:42:00.000Z" }),
    share({ id: "s2", dealId: "d2", contactName: "Omar Haddad", active: false, revokedAt: "2026-11-07T07:00:00.000Z" }),
  ];
  const html = section({ ...READY, pocket: { ...POCKET, shares } });
  assert.match(html, /Sara Khan — Opened 2× · last 10:42, 7 Nov/);
  assert.match(html, /Omar Haddad — Revoked/);
  assert.equal((html.match(/>Revoke</g) ?? []).length, 1);
  assert.doesNotMatch(section({ ...READY, pocket: { ...POCKET, shares } }, { canEdit: false }), />Revoke<|>Share</);
});

test("the share window: the message, Send on WhatsApp when there is a number, the copies", () => {
  const link = { url: "https://app.nexusagenticos.com/pocket/T", message: "Hi Sara, a private listing", whatsappUrl: "https://wa.me/971501112233?text=Hi" };
  const html = render(ShareWindow, { link, onCopy: noop });
  assert.match(html, /Hi Sara, a private listing/);
  assert.match(html, /<a[^>]*href="https:\/\/wa\.me\/971501112233\?text=Hi"[^>]*>Send on WhatsApp<\/a>/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, />Copy message</);
  assert.match(html, />Copy link</);
  assert.doesNotMatch(render(ShareWindow, { link: { ...link, whatsappUrl: null }, onCopy: noop }), /Send on WhatsApp/);
});

test("the share window says the truth about the link: anyone who has it can open it (final review)", () => {
  const html = render(ShareWindow, { link: { url: "u", message: "m", whatsappUrl: null }, onCopy: noop });
  assert.match(html, /The link works for 14 days\. Anyone who has it can open it — send it to this buyer only\. Revoke it from the card at any time\./);
  assert.doesNotMatch(html, /for this buyer only\./);
});

test("a pocket unit's portal switches are locked, with the reason", () => {
  const html = render(PortalsSection, { unit: READY, board: BOARD, canEdit: true, timezone: TZ, onSwitch: noop });
  assert.match(html, /A pocket listing stays off the portals — turn Pocket off to publish it\./);
  assert.equal((html.match(/role="switch"/g) ?? []).length, 3);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 3);
});

test("the board's cards say Pocket, and which buyer is interested", () => {
  const card = (c, props = {}) =>
    render(WorkflowCard, { card: c, today: "2026-11-07", now: NOW, timezone: TZ, onOpen: noop, ...props });
  assert.match(card(READY), />Pocket</);
  assert.doesNotMatch(card({ ...READY, pocket: { on: false, since: null, shares: [] } }), />Pocket</);
  assert.match(card(DEALS[0], { pocketInterest: true }), />Interested in a pocket listing</);
  assert.doesNotMatch(card(DEALS[0]), /Interested in a pocket listing/);
});

test("Portals + social is done for a pocket unit once it is shared privately", () => {
  assert.equal(isPublished(READY, BOARD), false);
  const shared = { ...READY, pocket: { ...POCKET, shares: [share({})] } };
  assert.equal(isPublished(shared, BOARD), true);
  assert.equal(isPublished({ ...shared, pocket: { ...shared.pocket, shares: [share({ active: false })] } }, BOARD), false);
});
