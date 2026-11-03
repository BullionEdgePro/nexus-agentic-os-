/**
 * The workflow board's rules (3 Nov 2026): which steps take cards, what a move
 * may not do, the advertising permit, closing, and what each step needs. One
 * module that the board's drag and the API's refusal both read, so the board
 * never offers a move the server refuses. Pure — no database, no browser.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §3, §6
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REAL_ESTATE_WORKFLOW,
  UNIT_STEPS,
  DEAL_STEPS,
  boardColumns,
  automaticSteps,
  nextSteps,
  purposeAfterMove,
  moveProblem,
  closeProblem,
  stepNeeds,
  permitState,
  daysInStepLabel,
} from "@nexus/shared";

const W = REAL_ESTATE_WORKFLOW;
const today = "2026-11-03";

const unit = (over = {}) => ({
  kind: "unit",
  id: "u1",
  step: "S5",
  inStepSince: "2026-11-01T08:00:00Z",
  reference: "Marina Gate 2 · 1204",
  community: null,
  propertyType: null,
  bedrooms: null,
  purpose: null,
  priceAed: null,
  cheques: null,
  ejariReady: false,
  titleDeed: false,
  ownerDocs: false,
  formASignedOn: null,
  permitNumber: null,
  permitExpiresOn: null,
  liveOn: [],
  owner: null,
  agent: null,
  notes: null,
  dealIds: [],
  ...over,
});

const deal = (over = {}) => ({
  kind: "deal",
  id: "d1",
  step: "D4",
  inStepSince: "2026-11-01T08:00:00Z",
  contact: { id: "c1", name: "Lead one" },
  purpose: "rent",
  budgetAed: null,
  offerAed: null,
  ejariNumber: null,
  kycDone: false,
  formFSignedOn: null,
  dldTransferOn: null,
  dealValueAed: null,
  commissionAed: null,
  agent: null,
  notes: null,
  unitIds: [],
  nextViewingAt: null,
  ...over,
});

const permitted = (over = {}) =>
  unit({ step: "S8", purpose: "rent", formASignedOn: "2026-10-01", permitNumber: "71234", permitExpiresOn: "2027-10-01", ...over });

test("cards live on S5–S10 and D3–D9; the first steps stay automatic", () => {
  assert.deepEqual([...UNIT_STEPS], ["S5", "S6", "S7", "S8", "S9", "S10"]);
  assert.deepEqual([...DEAL_STEPS], ["D3", "D4", "D5", "D6", "D7", "D8", "D9"]);
  assert.deepEqual(boardColumns(W, "supply").map((s) => s.id), ["S5", "S6", "S7", "S8", "S9", "S10"]);
  assert.deepEqual(boardColumns(W, "demand").map((s) => s.id), ["D3", "D4", "D5", "D6", "D7", "D8", "D9"]);
  assert.deepEqual(automaticSteps(W, "supply").map((s) => s.id), ["S1", "S2", "S3", "S4"]);
  assert.deepEqual(automaticSteps(W, "demand").map((s) => s.id), ["D1", "D2"]);
  assert.deepEqual(nextSteps(W, "S5"), ["S6", "S7"]);
  assert.deepEqual(nextSteps(W, "D6"), ["D7", "D8"]);
  assert.deepEqual(nextSteps(W, "nope"), []);
});

test("dropping a unit on Rent units or Sale units classifies it", () => {
  assert.equal(purposeAfterMove(unit({ purpose: "sale" }), "S6"), "rent");
  assert.equal(purposeAfterMove(unit({ purpose: null }), "S7"), "sale");
  assert.equal(purposeAfterMove(unit({ purpose: "rent" }), "S8"), "rent");
  assert.equal(purposeAfterMove(unit({ purpose: null }), "S8"), null);
});

test("an unclassified unit cannot go past classifying", () => {
  assert.equal(moveProblem(unit({ purpose: null }), "S8", today), "Classify it first: put it on Rent units or Sale units.");
  assert.equal(moveProblem(unit({ purpose: null }), "S6", today), null);
  assert.equal(moveProblem(unit({ purpose: null }), "S7", today), null);
});

test("no advertising without Form A and a Trakheesi permit valid today", () => {
  assert.equal(
    moveProblem(unit({ step: "S8", purpose: "rent" }), "S9", today),
    "Before it can be advertised: Form A signed date, Trakheesi permit number, permit expiry date."
  );
  assert.equal(
    moveProblem(unit({ step: "S8", purpose: "rent", permitNumber: "71234" }), "S10", today),
    "Before it can be advertised: Form A signed date, permit expiry date."
  );
  assert.equal(
    moveProblem(permitted({ permitExpiresOn: "2026-11-02" }), "S9", today),
    "Before it can be advertised: a permit that has not expired (it expired on 2 Nov 2026)."
  );
  // The last day of a permit still counts.
  assert.equal(moveProblem(permitted({ permitExpiresOn: "2026-11-03" }), "S9", today), null);
  assert.equal(moveProblem(permitted(), "S10", today), null);
  // Leaving the adverts needs no permit.
  assert.equal(moveProblem(unit({ step: "S9", purpose: "rent" }), "S8", today), null);
});

test("a rent deal takes tenancies and a sale deal takes purchases", () => {
  assert.equal(moveProblem(deal({ purpose: "sale" }), "D7", today), "Rent deal is for tenancies. This lead is buying.");
  assert.equal(moveProblem(deal({ purpose: "rent" }), "D8", today), "Sale deal is for purchases. This lead is renting.");
  assert.equal(moveProblem(deal({ purpose: "rent" }), "D7", today), null);
  assert.equal(moveProblem(deal({ purpose: "sale" }), "D8", today), null);
});

test("a card stays in its own lane and a move goes somewhere", () => {
  assert.equal(moveProblem(unit(), "S5", today), "It is already on this step.");
  assert.equal(moveProblem(unit(), "D4", today), "That step is not on this card's lane.");
  assert.equal(moveProblem(deal(), "S9", today), "That step is not on this card's lane.");
  assert.equal(moveProblem(unit(), "S2", today), "That step is not on this card's lane.");
  assert.equal(moveProblem(deal(), "D1", today), "That step is not on this card's lane.");
  // Backwards is allowed: corrections happen.
  assert.equal(moveProblem(deal({ step: "D6" }), "D4", today), null);
});

test("closing: let a rental, sell a sale, win only at the end", () => {
  assert.equal(closeProblem(unit({ purpose: "sale" }), "let"), "Only a unit to let can close as Let.");
  assert.equal(closeProblem(unit({ purpose: "rent" }), "sold"), "Only a unit for sale can close as Sold.");
  assert.equal(closeProblem(unit({ purpose: null }), "withdrawn"), null);
  assert.equal(closeProblem(unit({ purpose: "rent" }), "let"), null);
  assert.equal(closeProblem(deal({ step: "D5" }), "won"), "A deal closes as Won from Rent deal, Sale deal or CRM & commission.");
  assert.equal(closeProblem(deal({ step: "D9" }), "won"), null);
  assert.equal(closeProblem(deal({ step: "D3" }), "lost"), null);
  assert.equal(closeProblem(unit(), "won"), "That is not a way to close this card.");
  assert.equal(closeProblem(deal(), "let"), "That is not a way to close this card.");
});

test("what each step needs", () => {
  assert.deepEqual(stepNeeds(unit({ step: "S8", formASignedOn: "2026-10-01" })), [
    { label: "Form A signed", done: true },
    { label: "Trakheesi permit number", done: false },
    { label: "Permit expiry", done: false },
  ]);
  assert.deepEqual(stepNeeds(deal({ step: "D4", unitIds: [] })), [{ label: "At least one unit matched", done: false }]);
  assert.deepEqual(
    stepNeeds(unit({ step: "S5", reference: "X", propertyType: "apartment", bedrooms: 0, priceAed: 90000 })).map((n) => n.done),
    [true, true, true, true]
  );
  assert.deepEqual(stepNeeds(unit({ step: "S6", cheques: 4 })), [
    { label: "Cheques", done: true },
    { label: "Ejari-ready", done: false },
  ]);
  assert.deepEqual(stepNeeds(unit({ step: "S10", liveOn: ["bayut"] })), [{ label: "Live on at least one portal", done: true }]);
  assert.deepEqual(stepNeeds(deal({ step: "D5", nextViewingAt: null })), [{ label: "A viewing booked", done: false }]);
  assert.deepEqual(stepNeeds(deal({ step: "D7", ejariNumber: "" })), [{ label: "Ejari number", done: false }]);
  assert.deepEqual(stepNeeds(deal({ step: "D8", kycDone: true })).map((n) => [n.label, n.done]), [
    ["KYC/AML done", true],
    ["Form F signed", false],
    ["DLD transfer", false],
  ]);
  assert.deepEqual(stepNeeds(deal({ step: "D9", dealValueAed: 120000, commissionAed: 0 })), [
    { label: "Deal value", done: true },
    { label: "Commission", done: true },
  ]);
  assert.deepEqual(stepNeeds(deal({ step: "D3" })), []);
});

test("a permit is ok, expiring within 14 days, expired, or not there", () => {
  assert.equal(permitState(unit({ permitExpiresOn: "2026-11-02" }), today), "expired");
  assert.equal(permitState(unit({ permitExpiresOn: "2026-11-03" }), today), "expiring");
  assert.equal(permitState(unit({ permitExpiresOn: "2026-11-17" }), today), "expiring");
  assert.equal(permitState(unit({ permitExpiresOn: "2026-11-18" }), today), "ok");
  assert.equal(permitState(unit(), today), "none");
});

test("days in a step read as people say them", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");
  const ago = (h) => new Date(now - h * 3_600_000).toISOString();
  assert.equal(daysInStepLabel(ago(3), now), "today");
  assert.equal(daysInStepLabel(ago(26), now), "1 day");
  assert.equal(daysInStepLabel(ago(50), now), "2 days");
  assert.equal(daysInStepLabel(ago(-5), now), "today");
});
