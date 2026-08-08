// Unit tests for HTML text extraction and the SSRF guard on URL ingestion.
// Both are pure (the guard's IP check needs no network), so these import the
// real implementations with no mocks.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  htmlToText,
  extractTitle,
  decodeEntities,
  isBlockedAddress,
  stripSharedBoilerplate,
} from "@nexus/knowledge";

// ============================================================
// HTML → text
// ============================================================

test("script, style and comment contents never reach the text", () => {
  const html = `
    <html><head><style>.a{color:red}</style></head>
    <body><script>var secret = 42;</script><!-- hidden note -->
    <p>Visible copy.</p></body></html>`;
  const text = htmlToText(html);

  assert.match(text, /Visible copy/);
  assert.ok(!text.includes("color:red"), "CSS must not be embedded as prose");
  assert.ok(!text.includes("secret"), "JS must not be embedded as prose");
  assert.ok(!text.includes("hidden note"), "comments must not be embedded as prose");
});

test("site chrome is dropped so it does not pollute every chunk", () => {
  // Without this, nav/footer boilerplate repeats in every chunk of every page
  // and flattens similarity scores toward meaningless.
  const html = `
    <body>
      <nav>Home Products Contact</nav>
      <header>Big Brand Banner</header>
      <main><p>Our refund window is 30 days.</p></main>
      <footer>Copyright 2026 All rights reserved</footer>
    </body>`;
  const text = htmlToText(html);

  assert.match(text, /refund window is 30 days/);
  assert.ok(!text.includes("Home Products Contact"), "nav must be dropped");
  assert.ok(!text.includes("Big Brand Banner"), "header must be dropped");
  assert.ok(!text.includes("All rights reserved"), "footer must be dropped");
});

test("block elements become paragraph breaks the chunker can split on", () => {
  const text = htmlToText("<p>First point.</p><p>Second point.</p>");
  assert.match(text, /First point\.\s*\n\s*\n?\s*Second point\./);
});

test("entities are decoded, including numeric and hex forms", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry"), "Tom & Jerry");
  assert.equal(decodeEntities("caf&#233;"), "café");
  assert.equal(decodeEntities("caf&#xe9;"), "café");
  assert.equal(decodeEntities("&unknownentity;"), "&unknownentity;", "unknown entities pass through");
});

test("a malformed entity does not throw and fail the whole source", () => {
  assert.doesNotThrow(() => decodeEntities("&#999999999999;"));
  assert.doesNotThrow(() => decodeEntities("&#x11FFFFF;"));
});

test("title is extracted for use as the source name", () => {
  assert.equal(extractTitle("<html><title>  Pricing &amp; Plans </title></html>"), "Pricing & Plans");
  assert.equal(extractTitle("<html><body>no title</body></html>"), null);
});

test("extraction handles an empty or tag-only document without throwing", () => {
  assert.equal(htmlToText(""), "");
  assert.equal(htmlToText("<div></div>"), "");
});

// ============================================================
// Cross-page boilerplate removal
// ============================================================
// Structural chrome (nav/footer) is dropped by tag, but plenty of boilerplate
// sits in the body — a storefront cart drawer appears on every page. Embedded
// as prose it lands in the first chunk of every document and flattens ranking.

test("lines repeated across every page are removed as chrome", () => {
  const pages = [
    "Skip to content\nView cart\nShipping Policy\nWe deliver across all seven emirates.",
    "Skip to content\nView cart\nRefund Policy\nYou have 30 days to request a return.",
    "Skip to content\nView cart\nPrivacy Policy\nWe never sell your personal data.",
  ];
  const cleaned = stripSharedBoilerplate(pages);

  for (const page of cleaned) {
    assert.ok(!page.includes("Skip to content"), "chrome must be gone");
    assert.ok(!page.includes("View cart"), "chrome must be gone");
  }
  assert.match(cleaned[0], /seven emirates/, "page-specific content must survive");
  assert.match(cleaned[1], /30 days/);
  assert.match(cleaned[2], /never sell/);
});

test("a long repeated line is kept — it is more likely real shared policy than chrome", () => {
  const shared =
    "All orders are subject to our standard terms and conditions as published on this website.";
  const pages = [`${shared}\nAlpha page.`, `${shared}\nBeta page.`, `${shared}\nGamma page.`];
  const cleaned = stripSharedBoilerplate(pages);
  assert.ok(cleaned[0].includes(shared), "long repeated content must not be stripped as chrome");
});

test("too few documents means no judgement is made", () => {
  // With one or two pages there is not enough signal to tell chrome from content.
  const pages = ["Skip to content\nOnly page."];
  assert.deepEqual(stripSharedBoilerplate(pages), pages);
});

test("the threshold is conservative — a line below it is treated as content", () => {
  // "Menu" is on 3 of 4 pages (0.75), under the 0.8 default, so it survives.
  // Erring toward keeping text is the right bias: wrongly dropping a line
  // silently deletes knowledge, while wrongly keeping one only adds noise.
  const pages = ["Menu\nOne.", "Menu\nTwo.", "Menu\nThree.", "Unique line\nFour."];
  const cleaned = stripSharedBoilerplate(pages);
  assert.ok(cleaned[0].includes("Menu"), "3-of-4 is below threshold and must be kept");
  assert.match(cleaned[3], /Unique line/, "a line appearing once must survive");
});

test("a line on every page IS removed once the threshold is met", () => {
  const pages = ["Menu\nOne.", "Menu\nTwo.", "Menu\nThree.", "Menu\nFour."];
  const cleaned = stripSharedBoilerplate(pages);
  assert.ok(!cleaned[0].includes("Menu"), "4-of-4 is chrome");
  assert.match(cleaned[0], /One\./, "content still survives");
});

// ============================================================
// SSRF guard
// ============================================================
// The worker runs inside Docker beside postgres, redis and the API, and
// knowledge sources are tenant-supplied. An unguarded fetcher would read
// internal services and write the result into a searchable knowledge base.

test("loopback, private, and link-local IPv4 are blocked", () => {
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata — the classic SSRF target
    "100.64.0.1", // carrier-grade NAT
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
});

test("public IPv4 is allowed", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "93.184.216.34"]) {
    assert.equal(isBlockedAddress(address), false, `${address} must be allowed`);
  }
});

test("IPv6 loopback, unique-local and link-local are blocked", () => {
  for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1"]) {
    assert.equal(isBlockedAddress(address), true, `${address} must be blocked`);
  }
});

test("IPv4-mapped IPv6 is judged on the embedded address, not the prefix", () => {
  // ::ffff:10.0.0.1 is a private address wearing an IPv6 costume.
  assert.equal(isBlockedAddress("::ffff:10.0.0.1"), true);
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
});

test("a non-IP string is treated as blocked so callers must resolve first", () => {
  assert.equal(isBlockedAddress("postgres"), true);
  assert.equal(isBlockedAddress("not an ip"), true);
  console.log("PASS: HTML extraction drops chrome, SSRF guard blocks internal targets");
});
