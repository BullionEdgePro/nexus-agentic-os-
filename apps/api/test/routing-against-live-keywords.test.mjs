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
// Keywords are seeded by 008 and then REVISED by 014, which added ABR and
// rebalanced the law firm it collides with. Reading only 008 would test a
// vocabulary production no longer uses.
const MIGRATIONS = [
  join(here, "..", "..", "..", "packages", "db", "migrations", "008-tenant-profiles.sql"),
  join(here, "..", "..", "..", "packages", "db", "migrations", "014-abr-replaces-atif-ali.sql"),
];

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
  const pattern = /routing_keywords\s*=\s*\$kw\$([\s\S]*?)\$kw\$::text\[\][\s\S]*?where\s+slug\s*=\s*'([a-z-]+)'/g;

  // Later migrations override earlier ones for the same slug, exactly as they
  // do when applied in order against the database.
  const bySlug = new Map();
  for (const file of MIGRATIONS) {
    for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
      bySlug.set(match[2], parsePgArray(match[1]));
    }
  }

  // Atif Ali Production was removed by 014. Its 008 keywords are still in the
  // file as applied history, but the tenant is deactivated and must not appear
  // in routing — including here.
  bySlug.delete("atif-ali-production");

  return [...bySlug].map(([slug, routingKeywords]) => ({
    id: `org-${slug}`,
    slug,
    name: slug.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" "),
    routingKeywords,
  }));
}

const BUSINESSES = readSeededBusinesses();

test("the migration seeds every business with routing vocabulary", () => {
  // A tenant with no keywords can never win classification. It would sit in the
  // table looking correctly configured and be unreachable — which is exactly
  // the shape of defect this codebase keeps producing.
  assert.equal(BUSINESSES.length, 5, "all five businesses must be seeded");

  // Exact counts are not asserted any more: they were a useful drift alarm
  // while the roster was frozen, and a maintenance tax now that vocabularies
  // get rebalanced when tenants change. What matters is that every business
  // carries enough vocabulary to be reachable at all — a tenant with two
  // keywords sits in the table looking configured and never wins a match.
  for (const business of BUSINESSES) {
    assert.ok(
      business.routingKeywords.length >= 15,
      `${business.slug} has only ${business.routingKeywords.length} keywords`
    );
  }
  assert.ok(BUSINESSES.some((b) => b.slug === "abr"), "ABR must be routable");
  assert.ok(!BUSINESSES.some((b) => b.slug === "atif-ali-production"), "removed tenant must not route");
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
    // Juris Prime Legal — TRANSACTIONAL work. "I need a lawyer for a court
    // case" used to live here and deliberately does not any more: with two law
    // firms on the number that phrasing is ambiguous, and the ambiguity is the
    // correct answer. See the two-law-firms test below.
    ["how do I do company formation in a freezone?", "juris-prime-legal"],
    ["I need a power of attorney and a contract drafted", "juris-prime-legal"],
    ["أحتاج تأسيس شركة ووكالة", "juris-prime-legal"],
    // Property
    ["do you have a villa for rent in Dubai?", "sfs-international"],
    ["I want to arrange a viewing for an apartment", "sfs-international"],
    ["أبحث عن شقة للإيجار", "sfs-international"],
    // Litigation — ABR. The disputes vocabulary is what separates it from the
    // other law firm on the same number.
    ["I need a criminal defence lawyer, my brother was arrested", "abr"],
    ["we want to start arbitration over a construction delay", "abr"],
    ["أحتاج محامي جنائي، هناك توقيف", "abr"],
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

test("two law firms on one number: a vague legal enquiry ASKS rather than guessing", () => {
  // The design decision migration 014 is really about. ABR and Juris Prime
  // Legal share the generic vocabulary on purpose, so "I need a lawyer" ties
  // and triggers the triage question. Guessing would send a criminal matter to
  // a company-formation desk, or a company formation to a litigator — and
  // routing also selects which governance policy applies.
  const vague = classifyBusiness("I need a lawyer", BUSINESSES);
  assert.equal(vague.kind, "ambiguous", `expected ambiguous, got ${vague.kind}`);
  const slugs = vague.candidates.map((c) => c.slug).sort();
  assert.deepEqual(slugs, ["abr", "juris-prime-legal"]);
});

test("a specific legal enquiry still routes to the right firm", () => {
  // Ambiguity is only acceptable because specificity resolves it. If both of
  // these triaged too, the switchboard would be asking on every legal message.
  const criminal = classifyBusiness("criminal case, appeal to cassation", BUSINESSES);
  assert.equal(criminal.kind, "routed", criminal.kind);
  assert.equal(criminal.business.slug, "abr");

  const setup = classifyBusiness("company formation in a freezone, power of attorney", BUSINESSES);
  assert.equal(setup.kind, "routed", setup.kind);
  assert.equal(setup.business.slug, "juris-prime-legal");
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
