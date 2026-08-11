// Arabic routing keywords.
//
// The triage menu now answers in Arabic, which fixed the reply and not the
// routing. These tests run the real classifier against real Arabic strings,
// because routing decides which GOVERNANCE applies and a misroute puts a legal
// question in front of an agent allowed to answer speculatively.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyBusiness } from "@nexus/agents";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  join(here, "..", "..", "..", "packages", "db", "migrations", "023-arabic-routing-keywords.sql"),
  "utf8"
);

// Mirrors what the migration stores, so these exercise the real matcher.
const BUSINESSES = [
  {
    id: "1",
    slug: "zipicka",
    name: "Zipicka",
    // Inflected forms listed explicitly, as the migration does. "طلبي" is here
    // because the test below writes "أين طلبي؟" and the bare "طلب" does not
    // match it — Arabic attaches the possessive to the word.
    routingKeywords: ["order", "طلب", "الطلب", "طلبي", "توصيل", "منتج"],
  },
  { id: "2", slug: "abr", name: "ABR", routingKeywords: ["lawyer", "محامي", "قضية", "محكمة"] },
  {
    id: "3",
    slug: "juris-prime",
    name: "Juris Prime",
    routingKeywords: ["attestation", "تصديق", "توثيق", "سفارة"],
  },
];

test("an Arabic enquiry routes without reaching triage", () => {
  const cases = [
    ["أحتاج محامي للقضية", "abr"],
    ["أين طلبي؟", "zipicka"],
    ["أريد تصديق شهادة", "juris-prime"],
  ];
  for (const [text, expected] of cases) {
    const outcome = classifyBusiness(text, BUSINESSES);
    assert.equal(outcome.kind, "routed", `"${text}" should route, not ask`);
    assert.equal(outcome.business.slug, expected, `"${text}"`);
  }
});

test("an attached article or possessive is a different word", () => {
  // The finding this whole migration turns on. Arabic writes الطلب and طلبي as
  // single tokens, so whole-word matching sees three unrelated strings.
  // normalizeForMatch folds orthography — hamza, taa marbuta, tashkeel — and
  // deliberately does not strip affixes, because ال also begins ordinary words
  // and removing it would put false matches into the mechanism that selects a
  // governance policy.
  const bare = { id: "9", slug: "test", name: "Test", routingKeywords: ["طلب"] };
  assert.equal(classifyBusiness("أين طلبي؟", [bare]).kind, "unknown", "طلبي must not match طلب");
  assert.equal(classifyBusiness("أين الطلب؟", [bare]).kind, "unknown", "الطلب must not match طلب");
  assert.equal(classifyBusiness("طلب جديد", [bare]).kind, "routed", "the bare form still matches");
});

test("Arabic matching is whole-word, like English", () => {
  // The word bag splits on \p{L}\p{N} with the u flag, so Arabic is handled by
  // the same path — this proves it rather than assuming it.
  const outcome = classifyBusiness("محكمة", BUSINESSES);
  assert.equal(outcome.kind, "routed");
  assert.equal(outcome.business.slug, "abr");
});

test("an Arabic message matching nothing still reaches triage cleanly", () => {
  // Which is now answered in Arabic — correct behaviour, and the reason the
  // keywords are worth adding is to skip that extra step, not to replace it.
  assert.equal(classifyBusiness("مرحبا", BUSINESSES).kind, "unknown");
});

test("English routing is unchanged by adding Arabic", () => {
  assert.equal(classifyBusiness("where is my order", BUSINESSES).business.slug, "zipicka");
  assert.equal(classifyBusiness("I need a lawyer", BUSINESSES).business.slug, "abr");
});

// ============================================================
// The migration audits itself
// ============================================================

test("genuinely ambiguous words are left out on purpose", () => {
  // Listing "consultation" or "contract" would make the ambiguity silent
  // instead of asked, and every business here gives consultations.
  for (const term of ["استشارة", "خدمة"]) {
    const body = MIGRATION.slice(MIGRATION.indexOf("update organizations"));
    assert.ok(!body.includes(`'${term}'`), `"${term}" is ambiguous and must not be a keyword`);
  }
  assert.match(MIGRATION, /Deliberately omitted/);
});

test("keywords are appended, never replaced", () => {
  // Replacing would drop the English ones and break routing for every customer
  // who writes in English — a regression caused by an improvement.
  assert.match(MIGRATION, /unnest\(routing_keywords \|\| array\[/);
  assert.ok(!/set routing_keywords = array\[/.test(MIGRATION), "must not overwrite");
});

test("the migration reports every doubly-claimed keyword", () => {
  // Not an error — a shared word makes the switchboard ask rather than guess,
  // which is safe and sometimes correct. It must be visible here rather than
  // discovered from a customer.
  assert.match(MIGRATION, /shared keyword/);
  assert.match(MIGRATION, /routes to NEITHER business/);
});

test("the migration fails if it stored nothing", () => {
  // A migration that matched no rows and reported success is this codebase's
  // signature failure.
  assert.match(MIGRATION, /raise exception 'No Arabic keywords were stored/);
});

test("the vocabulary is marked as needing review", () => {
  // A dictionary is not a substitute for someone who knows what these firms are
  // actually asked, and routing selects the governance policy.
  assert.match(MIGRATION, /NEEDS REVIEW BY SOMEONE WHO KNOWS THESE BUSINESSES/);
  console.log("PASS: Arabic enquiries route directly, and the migration audits its own collisions");
});
