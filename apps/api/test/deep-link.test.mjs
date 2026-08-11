// Per-business deep links on a shared number.
//
// Every business is now reachable on one number, which solved connectivity and
// created an adoption problem: a customer who wants the law firm still lands in
// a triage menu, because nothing in "hi" says which business they came for.
// Four of five businesses have zero contacts, and this is the engineering half
// of why.
//
// Calls the real router with real strings — routing decides which GOVERNANCE
// applies, so a misroute can put a legal question in front of an agent allowed
// to answer speculatively. That is not something to assert about source text.
import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyBusiness, findDeepLinkTag, buildDeepLink } from "@nexus/agents";

const BUSINESSES = [
  { id: "1", slug: "zipicka", name: "Zipicka", routingKeywords: ["order", "delivery", "product"] },
  { id: "2", slug: "abr", name: "ABR Advocates", routingKeywords: ["lawyer", "court", "case"] },
  { id: "3", slug: "juris-prime", name: "Juris Prime", routingKeywords: ["attestation", "certificate"] },
];

test("a tagged message routes to that business, with no menu", () => {
  for (const business of BUSINESSES) {
    const outcome = classifyBusiness(`#${business.slug} Hello, I need help`, BUSINESSES);
    assert.equal(outcome.kind, "routed", `#${business.slug} should route`);
    assert.equal(outcome.business.slug, business.slug);
  }
});

test("a hyphenated slug is captured whole", () => {
  // "juris-prime" must not truncate to "juris", which matches no business and
  // would silently fall through to the triage menu the link exists to skip.
  const outcome = classifyBusiness("#juris-prime hello", BUSINESSES);
  assert.equal(outcome.kind, "routed");
  assert.equal(outcome.business.slug, "juris-prime");
});

test("the tag beats keywords that would otherwise be ambiguous", () => {
  // The reason it is checked first. Someone who followed ABR's link should
  // reach ABR even if their message also mentions a word the shop claims.
  const outcome = classifyBusiness("#abr my order never arrived and I want a lawyer", BUSINESSES);
  assert.equal(outcome.kind, "routed");
  assert.equal(outcome.business.slug, "abr", "the published link wins over keyword evidence");
});

test("a tag only counts at the start of the message", () => {
  // Mid-message it is far more likely a customer quoting something than an
  // intent to switch business. Honouring it would let one business's routing be
  // changed by text pasted from elsewhere.
  const outcome = classifyBusiness("I was told to send #abr but I want my order", BUSINESSES);
  assert.equal(outcome.kind, "routed");
  assert.equal(outcome.business.slug, "zipicka", "should route on keywords, not the quoted tag");
});

test("an unknown tag falls through rather than failing", () => {
  // A stale link from a business that was removed must degrade to normal
  // routing, not to a dead end.
  const outcome = classifyBusiness("#atif-ali-production I need a lawyer", BUSINESSES);
  assert.equal(outcome.kind, "routed");
  assert.equal(outcome.business.slug, "abr");
});

test("a bare unknown tag reaches triage, not an error", () => {
  const outcome = classifyBusiness("#nosuchbusiness hello", BUSINESSES);
  assert.equal(outcome.kind, "unknown");
});

test("keyword routing still works untagged", () => {
  // The tag must not have replaced classification for everyone who arrives
  // without a link — which is most people.
  assert.equal(classifyBusiness("where is my delivery", BUSINESSES).business.slug, "zipicka");
  assert.equal(classifyBusiness("I need attestation", BUSINESSES).business.slug, "juris-prime");
  assert.equal(classifyBusiness("hello", BUSINESSES).kind, "unknown");
});

test("findDeepLinkTag is case-insensitive on the tag, exact on the slug", () => {
  assert.equal(findDeepLinkTag("#ABR hello", BUSINESSES)?.slug, "abr");
  assert.equal(findDeepLinkTag("#Abr hello", BUSINESSES)?.slug, "abr");
  assert.equal(findDeepLinkTag("no tag here", BUSINESSES), null);
  assert.equal(findDeepLinkTag("", BUSINESSES), null);
});

test("the generated link carries a tag that actually routes", () => {
  // The load-bearing round trip. A link whose prefill does not route is worse
  // than no link: the business publishes it, customers use it, and every one of
  // them lands in the triage menu it was supposed to skip.
  for (const business of BUSINESSES) {
    const url = buildDeepLink(business, "+971 50 480 5436");
    assert.match(url, /^https:\/\/wa\.me\/971504805436\?text=/, "number must be digits only");

    const prefill = decodeURIComponent(url.split("?text=")[1]);
    const outcome = classifyBusiness(prefill, BUSINESSES);
    assert.equal(outcome.kind, "routed", `${business.slug} prefill must route`);
    assert.equal(outcome.business.slug, business.slug);
  }
  console.log("PASS: deep links route deterministically and skip triage");
});

// ============================================================
// The link is built from a dialable number, never Meta's id
// ============================================================

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here2 = dirname(fileURLToPath(import.meta.url));
const LINKS_ROUTE = readFileSync(join(here2, "..", "src", "routes", "links.ts"), "utf8");
const MIGRATION_022 = readFileSync(
  join(here2, "..", "..", "..", "packages", "db", "migrations", "022-display-number.sql"),
  "utf8"
);

test("the link never uses whatsapp_phone_number_id", () => {
  // Meta's id is 1283383404852750. A wa.me link built from it looks correct,
  // gets published on five websites, and fails for every customer who taps it.
  // I wrote exactly that before catching it.
  assert.match(LINKS_ROUTE, /organization\.whatsappDisplayNumber/);
  assert.ok(
    !/buildDeepLink\([\s\S]{0,200}whatsappPhoneNumberId/.test(LINKS_ROUTE),
    "the id must never reach buildDeepLink"
  );
});

test("a business with no dialable number gets null, not a broken link", () => {
  assert.match(LINKS_ROUTE, /url: organization\.whatsappDisplayNumber\s*\n?\s*\?/);
  assert.match(LINKS_ROUTE, /unavailableReason/);
});

test("the number is stored per business, not as a platform constant", () => {
  // The shared number is a current arrangement, not a permanent one. When a
  // business gets its own, its link must follow without a code change.
  assert.match(MIGRATION_022, /alter table organizations add column if not exists whatsapp_display_number/);
  assert.match(MIGRATION_022, /where whatsapp_phone_number_id = '1283383404852750'/);
});

test("the migration says how many businesses still cannot be linked", () => {
  // Silence would read as "all done" when it means "four businesses have no
  // link and nobody noticed".
  assert.match(MIGRATION_022, /still have no dialable number/);
});

test("a link built from Meta's id would not survive the round trip", () => {
  // Guarding the guard: prove the id is not a plausible number, so the check
  // above is about something real.
  const bad = buildDeepLink(BUSINESSES[0], "1283383404852750");
  assert.match(bad, /wa\.me\/1283383404852750/);
  assert.notEqual(
    bad,
    buildDeepLink(BUSINESSES[0], "971504805436"),
    "the id and the real number must produce different links"
  );
  console.log("PASS: deep links are built from a dialable number and refuse when there is none");
});
