// Unit tests for HTML text extraction and the SSRF guard on URL ingestion.
// Both are pure (the guard's IP check needs no network), so these import the
// real implementations with no mocks.
import { test } from "node:test";
import assert from "node:assert/strict";

import { htmlToText, extractTitle, decodeEntities, isBlockedAddress } from "@nexus/knowledge";

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
