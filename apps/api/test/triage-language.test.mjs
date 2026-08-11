// The triage menu is the first thing every unrouted customer sees.
//
// It was English-only on a platform whose customers are in Dubai. Lead scoring
// had already been fixed for Arabic; the one reply an unrouted Arabic speaker
// receives had not — which is the wrong way round, because someone who cannot
// read the menu cannot choose from it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildTriageMessage } from "@nexus/agents";

const here = dirname(fileURLToPath(import.meta.url));
const PROCESSOR = readFileSync(join(here, "..", "src", "queue", "processor.ts"), "utf8");

const BUSINESSES = [
  { id: "1", slug: "zipicka", name: "Zipicka", routingKeywords: [] },
  { id: "2", slug: "abr", name: "ABR Advocates", routingKeywords: [] },
];

const ARABIC = /\p{Script=Arabic}/u;

test("an Arabic enquiry gets an Arabic menu", () => {
  const message = buildTriageMessage(BUSINESSES, "مرحبا، أحتاج مساعدة");
  assert.ok(ARABIC.test(message), "the reply must be in Arabic");
  assert.ok(!/Just reply with the number/.test(message), "no English body");
});

test("an English enquiry still gets English", () => {
  const message = buildTriageMessage(BUSINESSES, "hi, I need help");
  assert.match(message, /Just reply with the number or the name/);
  assert.ok(!ARABIC.test(message.replace(/[A-Za-z0-9.\s!?',\n]/g, "")), "no stray Arabic");
});

test("both versions list every business, in the same order", () => {
  // The menu is answered by number. If the two languages listed businesses
  // differently, "2" would mean different things depending on what the customer
  // typed — a misroute caused entirely by the reply's own formatting.
  const english = buildTriageMessage(BUSINESSES, "hello");
  const arabic = buildTriageMessage(BUSINESSES, "مرحبا");
  for (const business of BUSINESSES) {
    assert.ok(english.includes(business.name), `${business.name} missing from English`);
    assert.ok(arabic.includes(business.name), `${business.name} missing from Arabic`);
  }
  assert.ok(english.indexOf("Zipicka") < english.indexOf("ABR"));
  assert.ok(arabic.indexOf("Zipicka") < arabic.indexOf("ABR"), "order must match across languages");
});

test("business names are not translated", () => {
  // Brand names, not text. "ABR Advocates" is what is on their door and what
  // the customer will search for.
  const arabic = buildTriageMessage(BUSINESSES, "مرحبا");
  assert.match(arabic, /ABR Advocates/);
  assert.match(arabic, /Zipicka/);
});

test("mixed script chooses Arabic", () => {
  // Deliberate asymmetry. Someone who typed Arabic can certainly read it; an
  // Arabic speaker handed an English menu may be unable to answer at all.
  // Guessing wrong in that direction costs the enquiry.
  const message = buildTriageMessage(BUSINESSES, "hello مرحبا");
  assert.ok(ARABIC.test(message));
});

test("no text at all falls back to English rather than throwing", () => {
  // The parameter is optional, and an older caller passing nothing must still
  // get a usable menu.
  const message = buildTriageMessage(BUSINESSES);
  assert.match(message, /Just reply with the number/);
});

test("the caller actually passes the customer's message", () => {
  // Without this the feature is inert: the function would be capable of Arabic
  // and never receive anything to detect it from — working code, no effect,
  // and nothing anywhere would say so.
  assert.match(PROCESSOR, /buildTriageMessage\(businesses, ctx\.text\)/);
  assert.match(PROCESSOR, /the menu answers in their script/);
  console.log("PASS: the triage menu answers in the script the customer wrote in");
});
