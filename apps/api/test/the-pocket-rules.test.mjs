// Pocket listings, the pure rules (7 Nov 2026): which buyers on the board fit a
// pocket unit, the message an agent sends with the private link, the WhatsApp
// link that opens it, and what Portals + social needs from a pocket unit.
//
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §3, §4, §7
import { test } from "node:test";
import assert from "node:assert/strict";
import { pocketMatches, pocketMessage, whatsappLink, stepNeeds, POCKET_SHARE_DAYS } from "@nexus/shared";

const UNIT = {
  kind: "unit", id: "u1", step: "S10", purpose: "sale", priceAed: 1_000_000,
  pocket: { on: true, since: "2026-11-07T08:00:00.000Z", shares: [] },
  portals: { bayut: { wanted: false }, dubizzle: { wanted: false }, property_finder: { wanted: false } },
  liveOn: [], formASignedOn: "2026-10-28", permitNumber: "71450", permitExpiresOn: "2027-10-27",
};
const deal = (id, budgetAed, over = {}) => ({
  kind: "deal", id, step: "D5", purpose: "sale", budgetAed, contact: { id: `c-${id}`, name: `Buyer ${id}` }, unitIds: [], ...over,
});

test("buyers who fit come first, closest budget first; then over budget, smallest gap first; then unknown", () => {
  const deals = [
    deal("far", 2_000_000),
    deal("unknown", null),
    deal("close", 950_000),
    deal("over", 800_000),
    deal("rent", 1_000_000, { purpose: "rent" }),
    deal("closing", 1_000_000, { step: "D9" }),
    deal("over-more", 500_000),
  ];
  const m = pocketMatches(UNIT, deals);
  assert.deepEqual(m.map((x) => x.deal.id), ["close", "far", "over", "over-more", "unknown"]);
  assert.deepEqual(m.map((x) => x.fit), ["fits", "fits", "over", "over", "unknown"]);
  assert.equal(m[2].overBy, 200_000);
  assert.equal(m[0].overBy, null);
  assert.ok(m.every((x) => x.shared === false));
});

test("a buyer with an active share is marked shared; an expired or revoked one is not", () => {
  const share = (dealId, active) => ({ id: `s-${dealId}`, dealId, active });
  const unit = { ...UNIT, pocket: { ...UNIT.pocket, shares: [share("close", true), share("far", false)] } };
  const m = pocketMatches(unit, [deal("close", 950_000), deal("far", 2_000_000)]);
  assert.deepEqual(m.map((x) => [x.deal.id, x.shared]), [["close", true], ["far", false]]);
});

test("the message says what it is, asks for discretion and signs off", () => {
  const p = {
    firstName: "Sara", title: "Palm villa with beach access", community: "Palm Jumeirah", priceAed: 12_500_000,
    url: "https://app.nexusagenticos.com/pocket/T", agentFirstName: "Aisha", businessName: "SFS International",
  };
  assert.equal(
    pocketMessage(p),
    "Hi Sara, a private listing I think fits what you're looking for: Palm villa with beach access, Palm Jumeirah, AED 12,500,000. It's off-market, so please keep it to yourself: https://app.nexusagenticos.com/pocket/T — Aisha, SFS International"
  );
  assert.equal(
    pocketMessage({ ...p, firstName: null, agentFirstName: null }),
    "Hi, a private listing I think fits what you're looking for: Palm villa with beach access, Palm Jumeirah, AED 12,500,000. It's off-market, so please keep it to yourself: https://app.nexusagenticos.com/pocket/T — SFS International"
  );
});

test("a WhatsApp link only for a number", () => {
  assert.equal(whatsappLink("971501112233", "a b"), "https://wa.me/971501112233?text=a%20b");
  assert.equal(whatsappLink("+971 50 111 2233", "x"), "https://wa.me/971501112233?text=x");
  assert.equal(whatsappLink("AE.1349abc", "x"), null);
  assert.equal(whatsappLink(null, "x"), null);
  assert.equal(whatsappLink("12345", "x"), null);
  assert.equal(POCKET_SHARE_DAYS, 14);
});

test("Portals + social asks a pocket unit to be shared privately, not to be on a portal", () => {
  const labels = (card, published) => stepNeeds(card, published).map((n) => `${n.label}:${n.done}`);
  const pocket = labels(UNIT, true);
  assert.ok(pocket.includes("Shared privately with a buyer:true"), pocket.join(" | "));
  assert.ok(!pocket.some((l) => l.startsWith("Live on at least one portal")));
  assert.ok(labels(UNIT, false).includes("Shared privately with a buyer:false"));
  const open = labels({ ...UNIT, pocket: { on: false, since: null, shares: [] } }, true);
  assert.ok(open.some((l) => l.startsWith("Live on at least one portal")));
});
