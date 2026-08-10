// Which pages of a tenant's website become the agent's knowledge.
//
// This is the one place in the ingestion path where a mistake is silent. A bad
// filter does not throw, does not log, and produces an agent that answers
// fluently and cites a real URL — the citation is what makes it worse than an
// ordinary hallucination, because it survives a spot check.
//
// The concrete near-miss: sfsintrealestate.com is a Dubai agency running an
// unreplaced Houzez demo theme, and its sitemap contains an
// `apartments-in-new-york` page plus dozens of stock listings. A first pass at
// the filter, written as `grid-[a-z-]*`, let `grid-full-width-2-cols` through
// and did not exclude the New York page at all.
import { test } from "node:test";
import assert from "node:assert/strict";

import { TENANT_SOURCES, selectPages, extractLocations } from "../src/scripts/ingest-site.ts";

const sfs = TENANT_SOURCES["sfs-international"];

// A representative slice of the real sitemap, taken from production on
// 2026-08-08. Real slugs, because invented ones would not have caught the bug.
const SFS_SITEMAP = [
  "https://sfsintrealestate.com/",
  "https://sfsintrealestate.com/about/",
  "https://sfsintrealestate.com/contact/",
  "https://sfsintrealestate.com/frequently-asked-questions/",
  "https://sfsintrealestate.com/insights/",
  "https://sfsintrealestate.com/privacy-policy/",
  "https://sfsintrealestate.com/terms-and-conditions/",
  // Theme demo pages
  "https://sfsintrealestate.com/apartments-in-new-york/",
  "https://sfsintrealestate.com/grid-full-width-2-cols/",
  "https://sfsintrealestate.com/grid-full-width-4-cols/",
  "https://sfsintrealestate.com/with-half-map/",
  "https://sfsintrealestate.com/list-layout-full-width/",
  "https://sfsintrealestate.com/testing/",
  // Account plumbing
  "https://sfsintrealestate.com/my-profile/",
  "https://sfsintrealestate.com/compare-properties/",
  "https://sfsintrealestate.com/invoices/",
  // Listings — demo stock and genuine UAE, both excluded
  "https://sfsintrealestate.com/property/chic-urban-studio/",
  "https://sfsintrealestate.com/property/central-apartment-with-doorman/",
  "https://sfsintrealestate.com/property/suburban-semi-detached-house/",
  "https://sfsintrealestate.com/property/best-location-g1-villa-plot-jebel-ali-hills/",
  "https://sfsintrealestate.com/property/office-for-sale-in-barsha-heights-tecom/",
];

test("no theme demo page reaches the real estate agent", () => {
  const kept = selectPages(SFS_SITEMAP, sfs.exclude);

  // The specific page that got through the first filter. A UAE agency's agent
  // must never learn about New York apartments.
  assert.ok(
    !kept.some((u) => u.includes("new-york")),
    "a New York listing page would be indexed onto a Dubai agency's agent"
  );

  // The digits case that defeated `grid-[a-z-]*`.
  for (const demo of ["grid-full-width-2-cols", "grid-full-width-4-cols", "with-half-map", "list-layout-full-width", "testing"]) {
    assert.ok(!kept.some((u) => u.includes(demo)), `${demo} is theme scaffolding, not content`);
  }
});

test("property listings are excluded entirely — genuine ones too", () => {
  const kept = selectPages(SFS_SITEMAP, sfs.exclude);
  assert.ok(!kept.some((u) => u.includes("/property/")), "no listing may be indexed");

  // Deliberate, not an oversight: a real Jebel Ali villa plot is excluded for
  // the same reason as a fake one. Property sells and prices move, a 6-hourly
  // re-index cannot keep a snapshot honest, and this tenant's system prompt
  // already forbids stating availability that is not in live context.
  assert.ok(!kept.some((u) => u.includes("jebel-ali-hills")));
  assert.ok(!kept.some((u) => u.includes("barsha-heights")));
});

test("the informational pages that remain are the ones worth answering from", () => {
  const kept = selectPages(SFS_SITEMAP, sfs.exclude);
  const paths = kept.map((u) => u.replace("https://sfsintrealestate.com", ""));

  assert.deepEqual(paths, [
    "/",
    "/about/",
    "/contact/",
    "/frequently-asked-questions/",
    "/insights/",
    "/privacy-policy/",
    "/terms-and-conditions/",
  ]);
});

test("the attestation tenant keeps its guides and drops only the blog index", () => {
  const source = TENANT_SOURCES["juris-prime"];
  const kept = selectPages(
    [
      "https://truecopyattestions.com/",
      "https://truecopyattestions.com/blog/",
      "https://truecopyattestions.com/mofa-attestation-process-in-uae/",
      "https://truecopyattestions.com/documents-required-for-uae-embassy-attestation/",
      "https://truecopyattestions.com/legal-translation-dubai/",
      "https://truecopyattestions.com/notary-public-dubai/",
    ],
    source.exclude
  );

  assert.ok(!kept.some((u) => u.endsWith("/blog/")), "the blog index is a list of links, not content");
  // The guides are the whole point — these answer the questions customers
  // actually send.
  assert.ok(kept.some((u) => u.includes("mofa-attestation-process")));
  assert.ok(kept.some((u) => u.includes("documents-required")));
  assert.equal(kept.length, 5);
});

test("the law firm's shop plumbing is not mistaken for a legal service", () => {
  const source = TENANT_SOURCES["juris-prime-legal"];
  const kept = selectPages(
    [
      "https://jurisprimelegal.ae/civil-lawyer-dubai/",
      "https://jurisprimelegal.ae/company-formation/",
      "https://jurisprimelegal.ae/power-of-attorney/",
      "https://jurisprimelegal.ae/cart/",
      "https://jurisprimelegal.ae/checkout/",
      "https://jurisprimelegal.ae/my-account/",
      "https://jurisprimelegal.ae/shop/",
    ],
    source.exclude
  );

  assert.deepEqual(
    kept.map((u) => u.replace("https://jurisprimelegal.ae", "")),
    ["/civil-lawyer-dubai/", "/company-formation/", "/power-of-attorney/"]
  );
});

test("the offline tenant has no source list at all", () => {
  // Atif Ali Production left the platform (migration 014), so its entry is
  // gone rather than commented out — a source list for a tenant that no longer
  // exists is a trap for whoever reads it next.
  assert.equal(TENANT_SOURCES["atif-ali-production"], undefined);

  // ABR replaced it. abshlaw.com is a single page with NO sitemap, so the URL
  // is listed by hand — a crawler pointed at it would have found nothing and
  // reported a clean run.
  assert.ok(TENANT_SOURCES["abr"], "ABR must have a source list");
  assert.deepEqual(TENANT_SOURCES["abr"].sitemaps, []);
  assert.deepEqual(TENANT_SOURCES["abr"].pages, ["https://www.abshlaw.com/"]);
});

test("sitemap parsing ignores nested index files", () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>https://example.com/page-sitemap.xml</loc></url>
    <url><loc>https://example.com/real-page/</loc></url>
  </urlset>`;
  assert.deepEqual(extractLocations(xml), ["https://example.com/real-page/"]);
  console.log("PASS: no demo listing or theme scaffolding can reach a tenant's agent");
});
