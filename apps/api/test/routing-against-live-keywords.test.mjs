// Routing, checked against the keywords that are actually in production.
//
// business-router.test.mjs proves the classifier is correct against a fixture.
// That is not the same as proving THIS platform routes correctly, because the
// fixture and the real seed data are two different things — and they have
// already disagreed once: migration 007 seeded `juris-prime` with licensing
// vocabulary written from the tenant's name, before anyone read the site. It is
// document attestation. Routing on those keywords would have sent attestation
// enquiries to a litigation agent and company-formation enquiries to an
// attestation agent, confidently and invisibly.
//
// So this reads the keyword arrays out of the migration that seeds them and
// runs the real classifier over them. The data and the behaviour can no longer
// drift apart without this failing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyBusiness, resolveTriageReply, buildTriageMessage } from "@nexus/agents";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(here, "..", "..", "..", "packages", "db", "migrations", "008-tenant-profiles.sql");

/**
 * Parse a Postgres text[] literal — `{a,b,"two words",عربي}`.
 *
 * Hand-rolled because the alternative is a database connection, and the point
 * of this test is to run everywhere the unit tests run.
 */
function parsePgArray(literal) {
  const body = literal.trim().replace(/^\{/, "").replace(/\}$/, "");
  const out = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (ch === "," && !quoted) {
      out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean).map((value) => value.replace(/\s+/g, " "));
}

/** Every `update organizations set routing_keywords = $kw$ ... $kw$ where slug = 'x'`. */
function readSeededBusinesses() {
  const sql = readFileSync(MIGRATION, "utf8");
  const pattern = /routing_keywords\s*=\s*\$kw\$([\s\S]*?)\$kw\$::text\[\][\s\S]*?where\s+slug\s*=\s*'([a-z-]+)'/g;

  const businesses = [];
  for (const match of sql.matchAll(pattern)) {
    businesses.push({
      id: `org-${match[2]}`,
      slug: match[2],
      name: match[2].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
      routingKeywords: parsePgArray(match[1]),
    });
  }
  return businesses;
}

const BUSINESSES = readSeededBusinesses();

test("the migration seeds every business with routing vocabulary", () => {
  // A tenant with no keywords can never win classification. It would sit in the
  // table looking correctly configured and be unreachable — which is exactly
  // the shape of defect this codebase keeps producing.
  assert.equal(BUSINESSES.length, 5, "all five businesses must be seeded");

  // Counts verified against production on 2026-08-08:
  // zipicka 26 · atif-ali-production 25 · juris-prime 21 · juris-prime-legal 25 · sfs-international 24
  const counts = Object.fromEntries(BUSINESSES.map((b) => [b.slug, b.routingKeywords.length]));
  assert.deepEqual(counts, {
    zipicka: 26,
    "juris-prime": 21,
    "juris-prime-legal": 25,
    "sfs-international": 24,
    "atif-ali-production": 25,
  });
});

test("every business carries Arabic vocabulary, not just English", () => {
  // The tenants are UAE-based. A business seeded English-only is unreachable to
  // half its customers, and nothing about the table would look wrong.
  for (const business of BUSINESSES) {
    const arabic = business.routingKeywords.filter((k) => /[؀-ۿ]/.test(k));
    assert.ok(arabic.length >= 5, `${business.slug} has only ${arabic.length} Arabic keywords`);
  }
});

test("real customer messages reach the right business", () => {
  const cases = [
    // Retail
    ["do you have this beauty product in stock?", "zipicka"],
    ["I want to buy pet food, do you deliver to Abu Dhabi?", "zipicka"],
    ["أريد شراء منتج للعناية", "zipicka"],
    // Attestation — NOT licensing. This is the pairing migration 008 corrected.
    ["I need true copy attestation for my degree certificate", "juris-prime"],
    ["do you do MOFA attestation and embassy stamp?", "juris-prime"],
    ["أحتاج تصديق شهادة من السفارة", "juris-prime"],
    // Legal — including business setup, which lives on the LEGAL site
    ["I need a lawyer for a court case", "juris-prime-legal"],
    ["how do I do company formation in a freezone?", "juris-prime-legal"],
    ["أحتاج محامي للمحكمة", "juris-prime-legal"],
    // Property
    ["do you have a villa for rent in Dubai?", "sfs-international"],
    ["I want to arrange a viewing for an apartment", "sfs-international"],
    ["أبحث عن شقة للإيجار", "sfs-international"],
    // Production
    ["I need video production for my brand", "atif-ali-production"],
    ["can you do filming and editing for a commercial?", "atif-ali-production"],
    ["أحتاج تصوير وانتاج فيديو", "atif-ali-production"],
  ];

  for (const [text, expected] of cases) {
    const outcome = classifyBusiness(text, BUSINESSES);
    assert.equal(outcome.kind, "routed", `"${text}" → ${outcome.kind}, expected routed`);
    assert.equal(outcome.business.slug, expected, `"${text}" routed to ${outcome.business.slug}`);
  }
});

test("attestation does not land on the law firm, and licensing does not land on attestation", () => {
  // The specific misroute migration 008 exists to prevent, asserted directly so
  // it cannot quietly come back.
  const attestation = classifyBusiness("certificate attestation and legal translation", BUSINESSES);
  assert.equal(attestation.kind, "routed");
  assert.equal(attestation.business.slug, "juris-prime");

  const setup = classifyBusiness("I want to set up a company, business setup mainland", BUSINESSES);
  assert.equal(setup.kind, "routed");
  assert.equal(setup.business.slug, "juris-prime-legal");
});

test("a production enquiry is never captured by the retail store", () => {
  // "video PRODUCTion" contains "product". Caught in review; whole-word matching
  // fixed it, and this asserts the real keyword lists still behave.
  for (const text of ["video production for a product launch", "studio production booking"]) {
    const outcome = classifyBusiness(text, BUSINESSES);
    if (outcome.kind === "routed") {
      assert.equal(outcome.business.slug, "atif-ali-production", text);
    }
  }
});

test("a greeting asks rather than guessing", () => {
  // What every new conversation on the shared number now begins with.
  for (const text of ["hi", "hello", "مرحبا", "good morning"]) {
    assert.equal(classifyBusiness(text, BUSINESSES).kind, "unknown", `"${text}"`);
  }

  const menu = buildTriageMessage(BUSINESSES);
  for (const business of BUSINESSES) {
    assert.ok(menu.includes(business.name), `${business.name} must be offered`);
  }
});

test("the menu answer resolves back to the business it offered", () => {
  // The ordinal has to match the order the menu was built in, or a customer
  // picking "3" lands somewhere other than the third name they read.
  BUSINESSES.forEach((business, index) => {
    const picked = resolveTriageReply(String(index + 1), BUSINESSES);
    assert.equal(picked?.slug, business.slug, `option ${index + 1} must be ${business.slug}`);
  });
  console.log(`PASS: routing verified against the ${BUSINESSES.length} live keyword sets`);
});
