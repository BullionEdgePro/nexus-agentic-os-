/**
 * Business HQ overview (spec 2026-10-14-business-hq-design.md §3.1): every
 * business on one screen, worst first, each with its score and what needs
 * doing. Rendered for real from a fixture response.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { HqOverview, scoreTone } from "@/app/deck/hq/overview";

const here = dirname(fileURLToPath(import.meta.url));
const NAV = readFileSync(join(here, "..", "lib", "nav.tsx"), "utf8");

const issue = (severity, title) => ({ code: title, severity, title, fix: "Do the thing." });
const BUSINESSES = [
  { slug: "zipicka", name: "Zipicka", logoUrl: null, websiteUrl: "https://zipicka.com", score: 97, topIssues: [issue("notice", "No structured data")], issueCount: 1 },
  { slug: "sfs-international", name: "SFS International", logoUrl: null, websiteUrl: "https://sfsintrealestate.com", score: 62, topIssues: [issue("critical", "SSL expires in 5 days"), issue("warning", "Mobile speed score is 45")], issueCount: 4 },
  { slug: "abr", name: "ABR Advocates", logoUrl: null, websiteUrl: "https://www.abshlaw.com", score: 100, topIssues: [], issueCount: 0 },
];

test("the worst business comes first, with its score and its top problem", () => {
  const html = renderToStaticMarkup(createElement(HqOverview, { businesses: BUSINESSES }));
  const sfs = html.indexOf("SFS International");
  const zip = html.indexOf("Zipicka");
  const abr = html.indexOf("ABR Advocates");
  assert.ok(sfs > -1 && sfs < zip && zip < abr, "sorted worst first");
  assert.match(html, />62</);
  assert.match(html, /SSL expires in 5 days/);
  assert.match(html, /href="\/deck\/hq\/sfs-international"/);
  assert.match(html, /sfsintrealestate\.com/);
});

test("a business with nothing wrong says so instead of showing an empty list", () => {
  const html = renderToStaticMarkup(createElement(HqOverview, { businesses: BUSINESSES }));
  assert.match(html, /All clear/);
  assert.match(html, /\+2 more/, "SFS has 4 issues, 2 shown");
});

test("the score ring's colour follows the score", () => {
  assert.equal(scoreTone(85), "good");
  assert.equal(scoreTone(80), "good");
  assert.equal(scoreTone(79), "warn");
  assert.equal(scoreTone(50), "warn");
  assert.equal(scoreTone(49), "crit");
});

test("Business HQ is in the rail for admins only", () => {
  const at = NAV.indexOf('href: "/deck/hq"');
  assert.ok(at > -1, "the nav item exists");
  const chunk = NAV.slice(at, NAV.indexOf("\n  },", at));
  assert.match(chunk, /label: "Business HQ"/);
  assert.match(chunk, /operatorOnly: true/);
});
