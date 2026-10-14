// A business's health is a number with reasons (Business HQ spec §4). Pure
// functions, run for real: the score, the issues behind it, how stale a note
// is, which address gets checked, and who hosts it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreHealth, hqIssues, staleness, normalizeBusinessHost, detectProvider } from "@nexus/shared";

const NOW = new Date("2026-10-14T06:00:00Z");
const daysFromNow = (d) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const ok = (data) => ({ ok: true, data, error: null, ranAt: NOW.toISOString() });
const healthy = () => ({
  checks: {
    rdap: ok({ registrar: "Hostinger", expiresAt: daysFromNow(300) }),
    dns: ok({ provider: "Hostinger", behindProxy: false }),
    tls: ok({ validTo: daysFromNow(80), issuer: "Let's Encrypt" }),
    http: ok({ status: 200, ms: 420 }),
    speed: ok({ mobile: 88, desktop: 97 }),
    seo: ok({ title: "SFS", titleLength: 40, metaDescription: "x", h1Count: 1, noindex: false, canonical: "/", jsonLd: true, robotsOk: true, robotsBlocksAll: false, sitemapOk: true }),
    platform: ok({ platform: "WordPress" }),
  },
  profile: null,
  keywords: [],
  socials: [],
  vault: [],
});
const titles = (issues) => issues.map((i) => `${i.severity}:${i.title}`);

test("the score starts at 100 and loses 25, 10 and 3 by severity, never below 0", () => {
  const i = (severity) => ({ code: severity, severity, title: severity, fix: "" });
  assert.equal(scoreHealth([]), 100);
  assert.equal(scoreHealth([i("critical"), i("warning"), i("notice")]), 62);
  assert.equal(scoreHealth(Array.from({ length: 10 }, () => i("critical"))), 0);
});

test("a healthy business has no issues", () => {
  assert.deepEqual(hqIssues(healthy(), NOW), []);
});

test("certificates and domains warn early and turn critical late", () => {
  const s = healthy();
  s.checks.tls = ok({ validTo: daysFromNow(5) });
  assert.deepEqual(titles(hqIssues(s, NOW)), ["critical:SSL expires in 5 days"]);
  s.checks.tls = ok({ validTo: daysFromNow(15) });
  assert.deepEqual(titles(hqIssues(s, NOW)), ["warning:SSL expires in 15 days"]);
  s.checks.tls = ok({ validTo: daysFromNow(80) });
  s.checks.rdap = ok({ expiresAt: daysFromNow(10) });
  assert.deepEqual(titles(hqIssues(s, NOW)), ["critical:Domain expires in 10 days"]);
  s.checks.rdap = ok({ expiresAt: daysFromNow(25) });
  assert.deepEqual(titles(hqIssues(s, NOW)), ["warning:Domain expires in 25 days"]);
});

test("a site that is down is critical; a slow one warns", () => {
  const s = healthy();
  s.checks.http = { ok: false, data: { status: 503 }, error: "HTTP 503", ranAt: NOW.toISOString() };
  assert.ok(titles(hqIssues(s, NOW)).includes("critical:Site is down"));
  const slow = healthy();
  slow.checks.speed = ok({ mobile: 45, desktop: 80 });
  assert.deepEqual(titles(hqIssues(slow, NOW)), ["warning:Mobile speed score is 45"]);
  slow.checks.speed = ok({ mobile: 65, desktop: 80 });
  assert.deepEqual(titles(hqIssues(slow, NOW)), ["notice:Mobile speed score is 65"]);
});

test("a check that could not run is shown, never counted as passing", () => {
  const s = healthy();
  s.checks.rdap = { ok: null, data: {}, error: "no RDAP service for .ae", ranAt: NOW.toISOString() };
  assert.deepEqual(titles(hqIssues(s, NOW)), ["notice:Could not check domain expiry"]);
  const never = healthy();
  delete never.checks.tls;
  assert.ok(titles(hqIssues(never, NOW)).includes("notice:Could not check the SSL certificate"));
});

test("notes that nobody updated become notices", () => {
  const s = healthy();
  s.profile = { gbpUrl: "https://g.page/sfs", gbpLastPostAt: daysFromNow(-9), gbpLastPhotoAt: daysFromNow(-10) };
  s.vault = [{ service: "Hostinger", label: "hPanel", hasSecret: true, secretChangedAt: daysFromNow(-200) }];
  s.socials = [{ platform: "instagram", handle: "@sfs", lastPostAt: daysFromNow(-3), twoFactor: false }];
  s.keywords = [{ keyword: "real estate dubai", checkedAt: daysFromNow(-31) }];
  assert.deepEqual(titles(hqIssues(s, NOW)).sort(), [
    "notice:Google Business Profile: no post in 9 days",
    "notice:Hostinger (hPanel) password unchanged for 200 days",
    "notice:Instagram @sfs has no two-factor sign-in",
    "notice:Keyword \"real estate dubai\" not checked in 31 days",
  ].sort());
});

test("staleness is fresh, stale or never", () => {
  assert.equal(staleness(daysFromNow(-3), 7, NOW), "fresh");
  assert.equal(staleness(daysFromNow(-8), 7, NOW), "stale");
  assert.equal(staleness(null, 7, NOW), "never");
});

test("the checked address is a public hostname, never an internal one", () => {
  assert.deepEqual(normalizeBusinessHost("https://www.sfsintrealestate.com/"), { host: "www.sfsintrealestate.com", registrable: "sfsintrealestate.com" });
  assert.deepEqual(normalizeBusinessHost("https://jurisprimelegal.ae"), { host: "jurisprimelegal.ae", registrable: "jurisprimelegal.ae" });
  assert.deepEqual(normalizeBusinessHost("abshlaw.co.uk"), { host: "abshlaw.co.uk", registrable: "abshlaw.co.uk" });
  for (const bad of ["http://10.0.0.5", "https://localhost:3000", "https://api.internal", "https://example.com:8080", "https://intranet", "https://printer.local", "javascript:alert(1)", ""]) {
    assert.equal(normalizeBusinessHost(bad), null, bad);
  }
});

test("who hosts it, and when Cloudflare hides the answer", () => {
  assert.equal(detectProvider({ nameservers: ["ns1.dns-parking.com"], ip: "1.2.3.4", ptr: null, headers: {} }).provider, "Hostinger");
  assert.deepEqual(detectProvider({ nameservers: ["kai.ns.cloudflare.com"], ip: "104.21.1.1", ptr: null, headers: { server: "cloudflare" } }), { provider: "Behind Cloudflare (real host hidden)", behindProxy: true });
  assert.equal(detectProvider({ nameservers: [], ip: null, ptr: null, headers: { "x-shopid": "1" } }).provider, "Shopify");
  assert.equal(detectProvider({ nameservers: [], ip: null, ptr: "x.myshopify.com", headers: {} }).provider, "Shopify");
  assert.equal(detectProvider({ nameservers: [], ip: null, ptr: null, headers: { "x-vercel-id": "dxb1::abc" } }).provider, "Vercel");
  assert.equal(detectProvider({ nameservers: [], ip: "5.6.7.8", ptr: "srv.example-host.net", headers: {} }).provider, "srv.example-host.net");
  assert.equal(detectProvider({ nameservers: [], ip: "5.6.7.8", ptr: null, headers: {} }).provider, "5.6.7.8");
  assert.equal(detectProvider({ nameservers: [], ip: null, ptr: null, headers: {} }).provider, "Unknown");
});

test("private, loopback, link-local and CGNAT addresses are recognised", async () => {
  const { isPrivateAddress } = await import("@nexus/shared");
  for (const ip of ["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["185.1.2.3", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2a02:4780::1"]) assert.equal(isPrivateAddress(ip), false, ip);
});

test("only http and https links are kept", async () => {
  const { safeHttpUrl } = await import("@nexus/shared");
  assert.equal(safeHttpUrl("https://hpanel.hostinger.com"), "https://hpanel.hostinger.com");
  assert.equal(safeHttpUrl("hpanel.hostinger.com"), "https://hpanel.hostinger.com");
  for (const bad of ["javascript:fetch('/x')", " JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd"]) assert.equal(safeHttpUrl(bad), null, bad);
});

// FOUND ON THE FIRST LIVE RUN: Zipicka read "Behind Cloudflare" — Shopify
// itself sits behind Cloudflare, and a Shopify signal is the better answer.
test("a Shopify store behind Cloudflare is named Shopify", () => {
  assert.equal(detectProvider({ nameservers: [], ip: "23.227.38.65", ptr: "myshopify.com", headers: { server: "cloudflare", "cf-ray": "x" } }).provider, "Shopify");
});
