// Unit tests for shared-number routing. Pure — no model, no database.
//
// Routing decides which tenant's GOVERNANCE applies, so the interesting cases
// are the ones where it must refuse to guess: putting a legal question in front
// of an agent allowed to answer speculatively is the failure this exists to
// prevent.
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyBusiness, resolveTriageReply, buildTriageMessage } from "@nexus/agents";

const BUSINESSES = [
  { id: "o1", slug: "zipicka", name: "Zipicka", routingKeywords: ["shop", "product", "order", "beauty", "pet", "منتج", "تسوق"] },
  { id: "o2", slug: "juris-prime", name: "Juris Prime", routingKeywords: ["license", "licence", "company formation", "freezone", "visa", "رخصة", "تأسيس"] },
  { id: "o3", slug: "juris-prime-legal", name: "Juris Prime Legal", routingKeywords: ["lawyer", "legal", "court", "case", "lawsuit", "محامي", "محكمة"] },
  { id: "o4", slug: "sfs-international", name: "SFS International", routingKeywords: ["property", "rent", "villa", "apartment", "عقار", "ايجار"] },
  { id: "o5", slug: "atif-ali-production", name: "Atif Ali Production", routingKeywords: ["video", "filming", "production", "فيديو", "تصوير"] },
];

test("a clear enquiry routes to exactly one business", () => {
  const r = classifyBusiness("Do you have this beauty product in stock?", BUSINESSES);
  assert.equal(r.kind, "routed");
  assert.equal(r.business.slug, "zipicka");
});

test("each business is reachable by its own vocabulary", () => {
  const cases = [
    ["I need a lawyer for a court case", "juris-prime-legal"],
    ["How do I get a trade licence in a freezone?", "juris-prime"],
    ["Do you have a villa for rent?", "sfs-international"],
    ["I want a video production for my brand", "atif-ali-production"],
  ];
  for (const [text, slug] of cases) {
    const r = classifyBusiness(text, BUSINESSES);
    assert.equal(r.kind, "routed", `"${text}" should route`);
    assert.equal(r.business.slug, slug);
  }
});

test("Arabic routes as well as English", () => {
  // UAE tenants; a customer writing in Arabic must be routable.
  const legal = classifyBusiness("أحتاج محامي للمحكمة", BUSINESSES);
  assert.equal(legal.kind, "routed");
  assert.equal(legal.business.slug, "juris-prime-legal");

  const shop = classifyBusiness("أريد شراء منتج", BUSINESSES);
  assert.equal(shop.kind, "routed");
  assert.equal(shop.business.slug, "zipicka");
});

test("an ambiguous message asks rather than guesses", () => {
  // "visa" is licensing and "lawyer" is legal — a one-keyword margin is not
  // enough to gamble a governance decision on.
  const r = classifyBusiness("I need a lawyer to help with my visa", BUSINESSES);
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.candidates.length, 2);
});

test("a decisive margin does route, so triage is not asked needlessly", () => {
  // Three legal keywords against one licensing keyword is not a coin flip.
  const r = classifyBusiness("My lawyer says the court case needs a lawsuit filed, plus a visa question", BUSINESSES);
  assert.equal(r.kind, "routed");
  assert.equal(r.business.slug, "juris-prime-legal");
});

test("a greeting with no signal is unknown, not a guess", () => {
  for (const text of ["hi", "hello", "مرحبا", "", "   "]) {
    assert.equal(classifyBusiness(text, BUSINESSES).kind, "unknown", `"${text}"`);
  }
});

// ============================================================
// Triage replies
// ============================================================

test("a bare number selects the listed business", () => {
  // The answer to "which business?" carries no routing keywords at all, so
  // without this the menu would loop forever.
  assert.equal(resolveTriageReply("2", BUSINESSES).slug, "juris-prime");
  assert.equal(resolveTriageReply("4", BUSINESSES).slug, "sfs-international");
  assert.equal(resolveTriageReply("1 please", BUSINESSES).slug, "zipicka");
});

test("a name reply matches, preferring the longest name", () => {
  // "Juris Prime" is a prefix of "Juris Prime Legal"; the longer must win or
  // legal enquiries land on the licensing agent.
  assert.equal(resolveTriageReply("juris prime legal", BUSINESSES).slug, "juris-prime-legal");
  assert.equal(resolveTriageReply("Juris Prime", BUSINESSES).slug, "juris-prime");
});

test("an out-of-range or nonsense reply resolves to nothing", () => {
  for (const text of ["9", "0", "banana", ""]) {
    assert.equal(resolveTriageReply(text, BUSINESSES), null, `"${text}"`);
  }
});

test("the triage message lists every option and makes no claims", () => {
  const message = buildTriageMessage(BUSINESSES);
  for (const b of BUSINESSES) assert.ok(message.includes(b.name), `${b.name} must be listed`);
  // Composed before any tenant's governance is known, so it must not assert
  // anything about price, legality, or availability.
  assert.ok(!/\b(price|guarantee|legal advice|free)\b/i.test(message));
  console.log("PASS: shared-number routing refuses to guess when governance is at stake");
});
