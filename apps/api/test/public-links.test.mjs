// The one page on this platform anybody may open.
//
// The links exist to be published — on websites, in Instagram bios, on QR codes
// taped to shop windows. But they lived behind an operator login, and the people
// who actually publish them (a web designer, whoever runs a social account, a
// printer) are not staff and never will be. A page only staff can reach reaches
// nobody, and four businesses stayed at zero customers.
//
// Making something public deserves an argument rather than a shrug, so these
// assertions are about the boundary: what it exposes, and what it must not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const LINKS_ROUTE = read("apps", "api", "src", "routes", "links.ts");
const API_INDEX = read("apps", "api", "src", "index.ts");
const MIDDLEWARE = read("apps", "web", "middleware.ts");
const PAGE = read("apps", "web", "app", "links", "page.tsx");

test("the public endpoint is mounted outside the authenticated prefix", () => {
  // requireAuth guards everything under /api/*. A public route mounted there
  // would 401 for exactly the people it exists to serve.
  assert.match(API_INDEX, /app\.route\("\/links", publicLinksRoute\)/);
  assert.ok(
    !/app\.route\("\/api\/links", publicLinksRoute\)/.test(API_INDEX),
    "the public route must not sit under /api/*"
  );
  // And the operator one keeps its guard.
  assert.match(API_INDEX, /app\.use\("\/api\/links", operatorOnly\)/);
});

test("both doors read the same builder", () => {
  // Two queries would let the page an operator sees and the page they hand to a
  // designer describe different links — and only one of them would be printed.
  assert.match(LINKS_ROUTE, /async function buildLinks\(\)/);
  assert.match(LINKS_ROUTE, /linksRoute\.get\("\/", async \(c\) => c\.json\(\{ links: await buildLinks\(\) \}\)\)/);
  assert.match(LINKS_ROUTE, /publicLinksRoute\.get\("\/"/);
});

test("it exposes links and nothing else", () => {
  // The whole safety argument: business names already on the front page, and a
  // number whose purpose is to be printed. No conversation, contact, employee
  // or metric may be reachable from here.
  const publicHandler = LINKS_ROUTE.slice(LINKS_ROUTE.indexOf('publicLinksRoute.get("/"'));
  for (const forbidden of [/conversation/i, /contact/i, /employee/i, /message/i, /metric/i]) {
    assert.ok(!forbidden.test(publicHandler), `public handler must not touch ${forbidden}`);
  }
});

test("the page is not gated by the web middleware", () => {
  // The matcher decides what needs a session. /links must not be in it, or the
  // designer is bounced to a sign-in screen they can never pass.
  const matcher = MIDDLEWARE.slice(MIDDLEWARE.indexOf("matcher:"));
  assert.ok(!/"\/links/.test(matcher), "/links must stay outside the auth matcher");
});

test("the page and its QR codes render without client JavaScript", () => {
  // It will be saved, emailed, and opened on a locked-down office machine or a
  // slow phone in a shop. Only the copy button is a client component.
  assert.ok(!/^"use client"/m.test(PAGE), "the page itself must stay a server component");
  assert.match(PAGE, /await QRCode\.toString/);
  assert.match(PAGE, /export const dynamic = "force-dynamic"/);
});

test("a failed fetch says so instead of showing an empty page", () => {
  // "No links" and "could not reach the server" look identical otherwise, and
  // the first sends someone away believing there is nothing to publish.
  assert.match(PAGE, /Could not reach the links service just now/);
  assert.match(PAGE, /No business has a WhatsApp number recorded yet/);
  console.log("PASS: the links are publishable by the people who publish them");
});
