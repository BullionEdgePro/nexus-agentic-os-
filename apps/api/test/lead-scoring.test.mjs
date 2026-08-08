// Unit tests for lead scoring. Pure — no model, no database — so the policy is
// pinned down without infrastructure, same as governance and presence.
import { test } from "node:test";
import assert from "node:assert/strict";

import { scoreLead, normalizeForMatch } from "@nexus/leads";

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
    "*Latest Owner, buyer and investor data available*\n📁March 2026",
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

// ============================================================
// Arabic
// ============================================================
// The tenants are UAE-based. An English-only scorer floored every Arabic
// customer at 'low' — the worst possible bias, since it buried exactly the
// local buyers these businesses most want to reach.

test("an Arabic price question is recognised as purchase intent", () => {
  // "How much is this? Is it available?"
  const r = scoreLead({ text: "السلام عليكم، بكم هذا المنتج؟ هل هو متوفر؟" });
  assert.equal(r.category, "purchase_intent");
  assert.notEqual(r.priority, "low");
});

test("an Arabic complaint is urgent, like its English counterpart", () => {
  // "My order arrived damaged, I want a refund."
  const r = scoreLead({ text: "طلبي وصل تالف وأريد استرداد المبلغ" });
  assert.equal(r.category, "complaint");
  assert.equal(r.priority, "urgent");
});

test("an Arabic booking request is recognised", () => {
  // "I would like to book an appointment for a consultation."
  const r = scoreLead({ text: "أرغب في حجز موعد للاستشارة" });
  assert.ok(["booking_intent", "legal_inquiry"].includes(r.category));
  assert.notEqual(r.priority, "low");
});

test("an Arabic cold pitch is pushed down, not up", () => {
  // "We are a company offering services... do you need...?"
  const r = scoreLead({ text: "نحن شركة نقدم خدمات تسويق، هل تحتاج عرض خاص؟" });
  assert.equal(r.category, "inbound_pitch");
  assert.equal(r.priority, "low");
});

test("Arabic spelling variants match the same rule", () => {
  // Arabic is written with interchangeable letterforms; matching raw strings
  // would catch one spelling and miss the rest, which reads as "Arabic
  // support" while failing on most real messages.
  const withHamza = scoreLead({ text: "أريد أشتري هذا" });   // أ
  const without = scoreLead({ text: "اريد اشتري هذا" });     // ا
  assert.equal(withHamza.category, without.category);
  assert.equal(withHamza.score, without.score);

  const taaMarbuta = scoreLead({ text: "هل هي متوفرة؟" });   // ة
  const haa = scoreLead({ text: "هل هي متوفره؟" });          // ه
  assert.equal(taaMarbuta.score, haa.score);
});

test("diacritics do not defeat matching", () => {
  // Harakat are decorative; the same word with and without them must score alike.
  const withTashkeel = scoreLead({ text: "بِكَمْ هذا؟" });
  const plain = scoreLead({ text: "بكم هذا؟" });
  assert.equal(withTashkeel.score, plain.score);
});

test("normalizeForMatch folds the variants it claims to", () => {
  assert.equal(normalizeForMatch("أإآ"), "ااا");
  assert.equal(normalizeForMatch("متوفرة"), "متوفره");
  assert.equal(normalizeForMatch("مُتَوَفِّر"), "متوفر");
  assert.equal(normalizeForMatch("١٢٣"), "123", "Arabic-Indic digits fold to ASCII");
  assert.equal(normalizeForMatch("HOW MUCH"), "how much", "English is unaffected apart from case");
});

test("an unrecognised message lands at low, not at an error", () => {
  // Languages beyond English and Arabic still score 0 — a deliberate floor
  // rather than a failure: the lead reaches the inbox, just unranked.
  for (const text of ["", "👋", "asdfghjkl", "你好我想买"]) {
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
