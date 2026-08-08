// Unit tests for lead scoring. Pure — no model, no database — so the policy is
// pinned down without infrastructure, same as governance and presence.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreLead } from "@nexus/leads";

test("a buying question scores as purchase intent", () => {
  const r = scoreLead({ text: "Hi, how much is the pet shampoo and do you have it in stock?" });
  assert.equal(r.category, "purchase_intent");
  assert.ok(r.score >= 30, `expected a meaningful score, got ${r.score}`);
  assert.ok(["high", "urgent"].includes(r.priority), `got ${r.priority}`);
});

test("a booking request is categorised as booking intent", () => {
  const r = scoreLead({ text: "I'd like to book a consultation about a trade licence." });
  assert.ok(["booking_intent", "legal_inquiry"].includes(r.category));
  assert.notEqual(r.priority, "low");
});

test("a complaint is ALWAYS urgent regardless of score", () => {
  // An unhappy customer produces few "high value" keywords and would otherwise
  // sink in a revenue-sorted inbox — exactly backwards, since a slow reply
  // costs most here.
  const r = scoreLead({ text: "My order arrived damaged and I want a refund." });
  assert.equal(r.category, "complaint");
  assert.equal(r.priority, "urgent");
});

test("an inbound B2B pitch is pushed down, not up", () => {
  // This is the dominant real traffic on the live number. Left unweighted it
  // trips purchase_intent on "products"/"order" and crowds out real customers.
  const r = scoreLead({
    text: "Hello, we are a pet food manufacturer with over 20 years of experience. We provide processing services and can supply products in bulk for your orders.",
  });
  assert.equal(r.category, "inbound_pitch");
  assert.equal(r.priority, "low");
  assert.ok(r.signals.some((s) => s.name === "inbound_pitch"));
});

test("a pitch containing buying words still classifies as a pitch", () => {
  const r = scoreLead({ text: "We are a supplier. What is your price and how many can you order?" });
  assert.equal(r.category, "inbound_pitch", "being a pitch overrides which words it contains");
});

// These are REAL messages from the production inbox. The first version of this
// scorer ranked the top one as the hottest lead in the account — it is someone
// selling data TO Zipicka. Pinned here so that regression cannot return.
test("real production spam is not ranked as a hot lead", () => {
  const spam = [
    "Do you want to purchase latest updates in very low price",
    "🏢PREMIUM DATA – MAY 2026 UPDATE",
    "🏙SHARJAH EXCLUSIVE VIP AREAS – 2026 🏙 AE N",
    "Do you need any data??",
  ];
  for (const text of spam) {
    const r = scoreLead({ text });
    assert.equal(r.priority, "low", `"${text.slice(0, 40)}" must not be prioritised (got ${r.priority}/${r.score})`);
  }
});

test("direction is what separates a buyer from a seller", () => {
  // Both contain purchase vocabulary; only one is a customer.
  const seller = scoreLead({ text: "Do you want to purchase our latest product list?" });
  const buyer = scoreLead({ text: "I want to purchase this, how much is it?" });

  assert.equal(seller.category, "inbound_pitch");
  assert.equal(seller.priority, "low");
  assert.equal(buyer.category, "purchase_intent");
  assert.notEqual(buyer.priority, "low");
});

test("a shouted broadcast is treated as promotional regardless of vocabulary", () => {
  // Structural signal, so it survives spam changing its wording next week.
  const shouted = scoreLead({ text: "MEGA OFFER THIS WEEK ONLY GRAB YOUR SPOT NOW" });
  assert.ok(
    shouted.signals.some((s) => s.matched.includes("shouted/broadcast formatting")),
    "all-caps blasts should register as broadcast"
  );

  // ...but a short shout is not evidence of anything.
  const normal = scoreLead({ text: "OK thanks" });
  assert.ok(!normal.signals.some((s) => s.name === "inbound_pitch"));
});

test("urgency lifts the score but is not a category on its own", () => {
  const plain = scoreLead({ text: "How much is delivery?" });
  const urgent = scoreLead({ text: "How much is delivery? I need it today, urgent." });
  assert.ok(urgent.score > plain.score, "urgency must raise the score");
  assert.equal(urgent.category, "purchase_intent", "urgency modifies, it does not categorise");
});

test("a returning contact scores above a first-time one", () => {
  const first = scoreLead({ text: "Do you have this in stock?", priorInboundCount: 0 });
  const returning = scoreLead({ text: "Do you have this in stock?", priorInboundCount: 4 });
  assert.ok(returning.score > first.score);
  assert.ok(returning.signals.some((s) => s.name === "returning_contact"));
});

test("a returning spammer gets no loyalty credit", () => {
  const r = scoreLead({ text: "We are a data provider offering b2b lead generation.", priorInboundCount: 9 });
  assert.ok(!r.signals.some((s) => s.name === "returning_contact"), "repeat spam is still spam");
  assert.equal(r.priority, "low");
});

test("scores stay within 0-100 at both extremes", () => {
  const everything = scoreLead({
    text: "urgent! bulk wholesale order, how much, price, book a consultation, legal contract, refund, damaged",
    priorInboundCount: 50,
  });
  assert.ok(everything.score <= 100, `got ${everything.score}`);

  const pitch = scoreLead({ text: "we are a supplier, our company, we specialize, partnership, seo" });
  assert.ok(pitch.score >= 0, `score must never go negative, got ${pitch.score}`);
});

test("an unrecognised message lands at low, not at an error", () => {
  // Arabic and other non-English text scores 0 today — a documented limitation.
  // It must degrade to a floor, never throw, so the lead still reaches the inbox.
  for (const text of ["", "👋", "مرحبا كيف حالك", "asdfghjkl"]) {
    const r = scoreLead({ text });
    assert.equal(r.priority, "low");
    assert.equal(r.category, "general_inquiry");
    assert.ok(r.score >= 0);
  }
});

test("every score carries the signals that produced it", () => {
  // A score with no record of why is unauditable, and "why is this urgent" is
  // the first question anyone asks of a scoring system.
  const r = scoreLead({ text: "I want to buy this urgently, what is the price?" });
  assert.ok(r.signals.length >= 2);
  for (const signal of r.signals) {
    assert.ok(signal.name && typeof signal.weight === "number" && Array.isArray(signal.matched));
    assert.ok(signal.matched.length > 0, "a signal must name what it matched on");
  }
  console.log("PASS: lead scoring ranks buyers up, pitches down, complaints urgent — with audit trail");
});
