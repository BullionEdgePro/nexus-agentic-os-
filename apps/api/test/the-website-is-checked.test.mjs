// The website is checked, and an unanswerable check says so (Business HQ spec
// §3.2, §7). Parsers run for real on saved homepages; the runner runs for real
// with its network injected, so the cases that bite in production — a .ae
// domain RDAP cannot answer, a PageSpeed timeout, an internal address, a
// redirect into the server's own network — are exercised without the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSeoSignals, detectPlatform, parseRdap, runHqChecks } from "../src/services/hq-checks.ts";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", "hq", name), "utf8");
const WP = fixture("wordpress-home.html");
const SHOP = fixture("shopify-home.html");
const BARE = fixture("bare-home.html");

test("the SEO basics are read from the homepage", () => {
  const wp = parseSeoSignals(WP);
  assert.equal(wp.title, "SFS International Real Estate | Property in Dubai");
  assert.equal(wp.titleLength, 49);
  assert.equal(wp.metaDescription, "Buy, sell and rent property in Dubai with SFS International Real Estate.");
  assert.equal(wp.h1Count, 1);
  assert.equal(wp.noindex, false);
  assert.equal(wp.canonical, "https://sfsintrealestate.com/");
  assert.equal(wp.jsonLd, true);
  assert.equal(parseSeoSignals(SHOP).h1Count, 2);
  const bare = parseSeoSignals(BARE);
  assert.equal(bare.title, null, "a blank title is no title");
  assert.equal(bare.metaDescription, null);
  assert.equal(bare.noindex, true);
  assert.equal(bare.jsonLd, false);
});

test("the platform is recognised", () => {
  assert.equal(detectPlatform(WP, {}), "WordPress");
  assert.equal(detectPlatform(SHOP, {}), "Shopify");
  assert.equal(detectPlatform(BARE, {}), null);
  assert.equal(detectPlatform("<html></html>", { "x-shopid": "1" }), "Shopify");
});

test("the registrar and expiry come from RDAP", () => {
  const sample = {
    events: [{ eventAction: "registration", eventDate: "2020-03-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-03-01T00:00:00Z" }],
    entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", "Hostinger Operations, UAB"]]] }],
  };
  assert.deepEqual(parseRdap(sample), { registrar: "Hostinger Operations, UAB", expiresAt: "2027-03-01T00:00:00.000Z" });
  assert.deepEqual(parseRdap({}), { registrar: null, expiresAt: null });
});

/** A network that answers like a healthy WordPress site, with overrides. */
function deps(over = {}) {
  const calls = [];
  const recorded = [];
  const responses = {
    "https://sfsintrealestate.com/": () => new Response(WP, { status: 200, headers: { server: "LiteSpeed" } }),
    "https://sfsintrealestate.com/robots.txt": () => new Response("User-agent: *\nDisallow: /wp-admin/\n", { status: 200 }),
    "https://sfsintrealestate.com/sitemap.xml": () => new Response("<?xml version='1.0'?><urlset></urlset>", { status: 200 }),
    bootstrap: () => new Response(JSON.stringify({ services: [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]]] }), { status: 200 }),
    rdap: () => new Response(JSON.stringify({ events: [{ eventAction: "expiration", eventDate: "2027-01-01T00:00:00Z" }] }), { status: 200 }),
    speed: () => new Response(JSON.stringify({ lighthouseResult: { categories: { performance: { score: 0.81 } } } }), { status: 200 }),
    ...over.responses,
  };
  return {
    calls,
    recorded,
    deps: {
      fetch: async (url) => {
        calls.push(String(url));
        const u = String(url);
        const key = u.includes("data.iana.org/rdap/dns.json") ? "bootstrap" : u.includes("rdap.") ? "rdap" : u.includes("pagespeedonline") ? "speed" : u;
        const make = responses[key];
        if (!make) return new Response("not found", { status: 404 });
        return make();
      },
      resolveNs: async () => ["ns1.dns-parking.com", "ns2.dns-parking.com"],
      resolve4: async () => ["185.1.2.3"],
      reverse: async () => [],
      tlsValidTo: async () => ({ validTo: "2026-12-30T00:00:00.000Z", issuer: "Let's Encrypt" }),
      lookup: async () => [{ address: "185.1.2.3", family: 4 }],
      record: async (row) => recorded.push(row),
      ...over.deps,
    },
  };
}

const ORG = { id: "org-1", websiteUrl: "https://sfsintrealestate.com" };

test("a healthy site passes every check and each result is recorded", async () => {
  const d = deps();
  const r = await runHqChecks(ORG, d.deps);
  for (const kind of ["rdap", "dns", "tls", "http", "speed", "seo", "platform"]) assert.equal(r[kind].ok, true, kind);
  assert.equal(r.dns.data.provider, "Hostinger");
  assert.equal(r.speed.data.mobile, 81);
  assert.equal(r.seo.data.sitemapOk, true);
  assert.equal(r.seo.data.robotsBlocksAll, false);
  assert.equal(r.platform.data.platform, "WordPress");
  assert.equal(d.recorded.length, 7);
});

test("a domain RDAP cannot answer reads unknown, and nothing else is lost", async () => {
  // The IANA registry list has no RDAP service for .ae (checked 14 Oct 2026).
  const d = deps();
  const r = await runHqChecks({ id: "org-2", websiteUrl: "https://jurisprimelegal.ae" }, {
    ...d.deps,
    fetch: async (url) => d.deps.fetch(String(url).replace("jurisprimelegal.ae", "sfsintrealestate.com")),
  });
  assert.equal(r.rdap.ok, null);
  assert.match(r.rdap.error, /\.ae/);
  assert.ok(!d.calls.some((u) => u.includes("rdap.verisign")), "no registry was asked about a .ae domain");
  assert.equal(r.http.ok, true);
  assert.equal(r.tls.ok, true);
});

// FOUND ON THE FIRST LIVE RUN (14 Oct 2026): every domain read "HTTP 403".
// rdap.org only forwards to the registry, and Verisign refuses Node's default
// request identity. The registry is asked directly, from IANA's list, with a
// named user agent.
test("the registry itself is asked, by name, from IANA's list", async () => {
  const seen = [];
  const d = deps();
  const r = await runHqChecks(ORG, { ...d.deps, fetch: async (url, init) => { seen.push({ url: String(url), init }); return d.deps.fetch(url, init); } });
  assert.equal(r.rdap.ok, true);
  const asked = seen.find((x) => x.url.startsWith("https://rdap.verisign.com/com/v1/domain/"));
  assert.ok(asked, "the .com registry was asked directly");
  assert.equal(asked.url, "https://rdap.verisign.com/com/v1/domain/sfsintrealestate.com");
  assert.match(String(new Headers(asked.init?.headers).get("user-agent")), /NexusBusinessHQ/);
  assert.ok(!seen.some((x) => x.url.includes("rdap.org")), "no third-party redirector");
});

test("a PageSpeed timeout leaves speed unknown and the other checks complete", async () => {
  const d = deps({ responses: { speed: () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); } } });
  const r = await runHqChecks(ORG, d.deps);
  assert.equal(r.speed.ok, null);
  assert.equal(r.seo.ok, true);
  assert.equal(r.rdap.ok, true);
});

test("an internal address is never fetched", async () => {
  const d = deps();
  const r = await runHqChecks({ id: "org-3", websiteUrl: "http://127.0.0.1" }, d.deps);
  for (const kind of ["rdap", "dns", "tls", "http", "speed", "seo", "platform"]) {
    assert.equal(r[kind].ok, null, kind);
    assert.equal(r[kind].error, "Not a public website address");
  }
  assert.equal(d.calls.length, 0, "no request was made");
});

test("a redirect into the server's own network is not followed", async () => {
  const d = deps({ responses: { "https://sfsintrealestate.com/": () => new Response("", { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }) } });
  const r = await runHqChecks(ORG, d.deps);
  assert.equal(r.http.ok, false);
  assert.match(r.http.error, /redirect/i);
  assert.ok(!d.calls.some((u) => u.includes("169.254")), "the internal address was never requested");
});

test("robots.txt that blocks everything is caught", async () => {
  const d = deps({ responses: { "https://sfsintrealestate.com/robots.txt": () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }) } });
  const r = await runHqChecks(ORG, d.deps);
  assert.equal(r.seo.data.robotsBlocksAll, true);
});

// FINAL REVIEW, Important 2: the guard read a hostname's SPELLING, so a public
// name that RESOLVES to a private address (169.254.169.254.nip.io, or a
// rebinding record) was fetched. Every hop is now resolved and refused when any
// address is private, loopback, link-local or CGNAT.
test("a public name that resolves to an internal address is never fetched", async () => {
  const d = deps({ deps: { lookup: async () => [{ address: "169.254.169.254", family: 4 }] } });
  const r = await runHqChecks(ORG, d.deps);
  assert.equal(r.http.ok, false);
  assert.match(r.http.error, /private address/);
  assert.ok(!d.calls.some((u) => u.startsWith("https://sfsintrealestate.com")), "the site itself was never requested");
});

test("a redirect to a name that resolves privately is refused", async () => {
  const d = deps({
    responses: { "https://sfsintrealestate.com/": () => new Response("", { status: 301, headers: { location: "https://metadata.example-rebind.com/" } }) },
    deps: { lookup: async (host) => [{ address: host === "metadata.example-rebind.com" ? "10.0.0.7" : "185.1.2.3", family: 4 }] },
  });
  const r = await runHqChecks(ORG, d.deps);
  assert.equal(r.http.ok, false);
  assert.ok(!d.calls.some((u) => u.includes("example-rebind")));
});
