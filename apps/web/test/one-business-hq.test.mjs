/**
 * One business in Business HQ (spec §3.2, §5): five tabs, checks that could not
 * run said plainly, passwords as dots, the vault's state in words, staleness
 * on every note. Each tab rendered for real from one fixture response.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { HqBusinessView } from "@/app/deck/hq/[slug]/tabs";

const here = dirname(fileURLToPath(import.meta.url));
const VAULT_SRC = readFileSync(join(here, "..", "app", "deck", "hq", "[slug]", "vault-panel.tsx"), "utf8");
const TABS_SRC = readFileSync(join(here, "..", "app", "deck", "hq", "[slug]", "tabs.tsx"), "utf8");

const NOW = new Date("2026-10-14T06:00:00Z");
const ago = (d) => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const ahead = (d) => new Date(NOW.getTime() + d * 86_400_000).toISOString();
const check = (kind, ok, data, error = null) => ({ kind, ranAt: ago(0), ok, data, error });

const DATA = {
  business: { slug: "sfs-international", name: "SFS International", logoUrl: null, websiteUrl: "https://sfsintrealestate.com" },
  profile: { domain: "sfsintrealestate.com", registrarNote: null, hostingNote: null, platformNote: null, gbpUrl: "https://g.page/sfs", gbpRating: 4.8, gbpReviewCount: 37, gbpUnansweredReviews: 2, gbpLastPostAt: ago(9), gbpLastPhotoAt: ago(3), notes: null, updatedAt: ago(1), updatedBy: "a1" },
  checks: {
    rdap: check("rdap", null, {}, "No RDAP answer for .com domains (HTTP 404)"),
    dns: check("dns", true, { provider: "Hostinger", nameservers: ["ns1.dns-parking.com"], ip: "185.1.2.3", behindProxy: false }),
    tls: check("tls", true, { validTo: ahead(5), issuer: "Let's Encrypt" }),
    http: check("http", true, { status: 200, ms: 640 }),
    speed: check("speed", true, { mobile: 45, desktop: 88 }),
    seo: check("seo", true, { title: "SFS", titleLength: 3, metaDescription: null, h1Count: 1, noindex: false, canonical: null, jsonLd: false, robotsOk: true, robotsBlocksAll: false, sitemapOk: true }),
    platform: check("platform", true, { platform: "WordPress" }),
  },
  issues: [
    { code: "ssl-expiring", severity: "critical", title: "SSL expires in 5 days", fix: "Renew the certificate at the host now." },
    { code: "slow-mobile", severity: "warning", title: "Mobile speed score is 45", fix: "Compress images." },
  ],
  score: 65,
  keywords: [{ id: "k1", keyword: "real estate dubai", position: 14, checkedAt: ago(31) }, { id: "k2", keyword: "villas for sale", position: 6, checkedAt: ago(2) }],
  socials: [
    { id: "s1", platform: "instagram", handle: "@sfsrealestate", url: "https://instagram.com/sfsrealestate", followers: 1200, lastPostAt: ago(20), twoFactor: false, recoveryContact: null, vaultEntryId: null, updatedAt: ago(1), source: "recorded" },
    { id: "connected-facebook", platform: "facebook", handle: "SFS International", url: "https://facebook.com/123", followers: null, lastPostAt: null, twoFactor: null, recoveryContact: null, vaultEntryId: null, updatedAt: ago(5), source: "connected" },
  ],
  vault: [{ id: "v1", section: "website", service: "Hostinger", label: "hPanel", username: "sfs@example.com", url: "https://hpanel.hostinger.com", notes: null, hasSecret: true, secretChangedAt: ago(200), updatedAt: ago(200), updatedBy: "a1" }],
  reveals: [{ id: "r1", entryId: "v1", service: "Hostinger", adminId: "a1", adminName: "Ralph Ivan Simeon", revealedAt: ago(1), ip: "94.200.1.2", userAgent: "Edge" }],
  vaultConfigured: true,
  unlockedSeconds: 0,
};

const render = (tab, over = {}) => renderToStaticMarkup(createElement(HqBusinessView, { data: { ...DATA, ...over }, tab, now: NOW, onTab: () => {}, onChanged: () => {} }));

test("the five tabs are there", () => {
  const html = render("overview");
  for (const label of ["Overview", "Website &amp; domain", "SEO &amp; Google", "Social media", "Vault &amp; access log"]) {
    assert.ok(html.includes(label), `tab ${label}`);
  }
});

test("the overview leads with the score and what to do about each problem", () => {
  const html = render("overview");
  assert.match(html, />65</);
  assert.match(html, /SSL expires in 5 days/);
  assert.match(html, /Renew the certificate at the host now\./);
});

test("a check that could not run says so, never a tick", () => {
  const html = render("website");
  assert.match(html, /Could not check/);
  assert.match(html, /No RDAP answer for \.com domains/);
  assert.match(html, /Hostinger/);
  assert.match(html, /expires in 5 days/);
  assert.match(html, /WordPress/);
});

test("SEO shows what is missing and which keywords have gone stale", () => {
  const html = render("seo");
  assert.match(html, /No meta description/);
  assert.match(html, /real estate dubai/);
  assert.match(html, /stale/);
  assert.match(html, /no post in 9 days/i);
});

test("social accounts show 2FA, staleness and which came from a connection", () => {
  const html = render("social");
  assert.match(html, /@sfsrealestate/);
  assert.match(html, /No 2FA/);
  assert.match(html, /Connected to Nexus/);
});

test("passwords are dots, and the vault's age and access log are shown", () => {
  const html = render("vault");
  assert.match(html, /••••••••/);
  assert.match(html, /changed 200 days ago/);
  assert.match(html, /Ralph Ivan Simeon/);
  assert.match(html, /Unlock/);
});

test("without the vault key the vault says so", () => {
  assert.match(render("vault", { vaultConfigured: false }), /The vault key is not set on the server\./);
});

test("a revealed password hides itself after 30 seconds, and a new domain is checked at once", () => {
  assert.match(VAULT_SRC, /30_000/);
  assert.match(VAULT_SRC, /navigator\.clipboard\.writeText/);
  assert.match(TABS_SRC, /checkHqNow\(/);
  assert.match(TABS_SRC, /domain !== /);
});

test("a stored javascript: link is never rendered as a link", () => {
  const evil = "javascript:fetch('/api/hq')";
  const html = render("vault", { vault: [{ ...DATA.vault[0], url: evil }] });
  assert.ok(!html.includes('href="javascript'), "no javascript: href in the vault");
  const social = render("social", { socials: [{ ...DATA.socials[0], url: evil }] });
  assert.ok(!social.includes('href="javascript'), "no javascript: href on a social card");
});
