/**
 * A unit card chooses its agent (28 Nov 2026). An admin-made unit had nobody and no way to choose,
 * so it could never go on the portals ("an agent on the card"); staff could not hand a unit over.
 * Spec: docs/superpowers/specs/2026-11-28-unit-agent-picker-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { REAL_ESTATE_WORKFLOW } from "@nexus/shared";
import { CardDetail } from "@/app/deck/workflow/board/card-detail";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-11-28T12:00:00Z");
const AISHA = { id: "e1", name: "Aisha Khan" };
const OMAR = { id: "e2", name: "Omar Haddad" };

const unit = (over) => ({
  kind: "unit", id: "u0", step: "S5", inStepSince: new Date(NOW).toISOString(), reference: "Marina Gate 2 · 1204",
  community: null, propertyType: null, bedrooms: null, purpose: null, priceAed: null, cheques: null, ejariReady: false,
  titleDeed: false, ownerDocs: false, formASignedOn: null, permitNumber: null, permitExpiresOn: null, liveOn: [],
  owner: null, agent: null, notes: null, dealIds: [], updatedAt: new Date(NOW).toISOString(), title: null,
  description: null, sizeSqft: null, bathrooms: null, furnishing: null, city: "Dubai", subCommunity: null,
  building: null, parking: null, amenities: [], availableFrom: null, photos: [],
  portals: { bayut: { wanted: false }, dubizzle: { wanted: false }, property_finder: { wanted: false } },
  ...over,
});
const deal = (over) => ({
  kind: "deal", id: "d0", step: "D4", inStepSince: new Date(NOW).toISOString(), contact: { id: "c1", name: "Lead one" },
  purpose: "rent", budgetAed: null, offerAed: null, ejariNumber: null, kycDone: false, formFSignedOn: null,
  dldTransferOn: null, dealValueAed: null, commissionAed: null, agent: AISHA, notes: null, unitIds: [],
  nextViewingAt: null, ...over,
});
const BOARD = {
  units: [], deals: [], hidden: {}, hotWaiting: [], closed30: { let: 0, sold: 0, won: 0, commissionAed: 0 },
  today: "2026-11-28", portalFeed: null, ornSet: true, agentBrns: {},
};
const detail = (card, over = {}) =>
  renderToStaticMarkup(
    createElement(CardDetail, {
      workflow: REAL_ESTATE_WORKFLOW, card, board: BOARD, history: [], now: NOW, timezone: "Asia/Dubai",
      origin: null, message: "", onSave: async () => true, onMove() {}, onCloseCard() {}, onLink() {},
      onUnlink() {}, onDismiss() {}, ...over,
    }),
  );
const picker = (html) => /<select[^>]*aria-label="Agent"[^>]*>([\s\S]*?)<\/select>/.exec(html);

test("a unit card offers its agent: Nobody yet and the business's staff", () => {
  const html = detail(unit({ agent: null }), { agents: [AISHA, OMAR] });
  const m = picker(html);
  assert.ok(m, "no Agent choice on the unit card");
  assert.match(m[1], /<option value="" selected="">Nobody yet<\/option>/);
  assert.match(m[1], /<option value="e1">Aisha Khan<\/option>/);
  assert.match(m[1], /<option value="e2">Omar Haddad<\/option>/);
});

test("the current agent is the chosen one, even after they left the staff", () => {
  assert.match(picker(detail(unit({ agent: OMAR }), { agents: [AISHA, OMAR] }))[1], /<option value="e2" selected="">Omar Haddad<\/option>/);
  const gone = { id: "e9", name: "Sara Gone" };
  const m = picker(detail(unit({ agent: gone }), { agents: [AISHA] }));
  assert.match(m[1], /<option value="e9" selected="">Sara Gone<\/option>/);
});

test("no choice for View as staff, for a deal, or before the staff list arrives", () => {
  assert.equal(picker(detail(unit({ agent: AISHA }), { agents: [AISHA], canEdit: false })), null);
  assert.equal(picker(detail(deal({}), { agents: [AISHA] })), null);
  assert.equal(picker(detail(unit({ agent: AISHA }), { agents: null })), null);
  assert.equal(picker(detail(unit({ agent: AISHA }))), null);
});

test("choosing saves at once through the card's own save", () => {
  const S = read("app/deck/workflow/board/card-detail.tsx");
  assert.match(S, /onChange=\{\(e\) => void onSave\(\{ agentEmployeeId: e\.target\.value \|\| null \}\)\}/);
});

test("the board panel loads the business's active staff and hands them to the card", () => {
  const P = read("app/deck/workflow/board/board-panel.tsx");
  assert.match(P, /getTeam\(slug\)/);
  assert.match(P, /\.filter\(\(member\) => member\.isActive\)/);
  assert.match(P, /agents=\{agents\}/);
});
