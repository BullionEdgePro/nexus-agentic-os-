/**
 * 30 Oct 2026: the owner made bulk messaging the two admin accounts' alone.
 * Staff chat one to one; admins choose the number and the customers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { STAFF_BULK_PATHS } from "../src/routes/my-campaigns.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const INDEX = read("apps", "api", "src", "index.ts");
const ADMIN = read("apps", "api", "src", "routes", "admin-bulk.ts");
const STAFF = read("apps", "api", "src", "routes", "my-campaigns.ts");
const NAV = read("apps", "web", "lib", "nav.tsx");

test("the admin bulk API sits behind operatorOnly on its whole prefix", () => {
  assert.match(INDEX, /app\.use\("\/api\/bulk", operatorOnly\);/);
  assert.match(INDEX, /app\.use\("\/api\/bulk\/\*", operatorOnly\);/);
  assert.match(INDEX, /app\.route\("\/api\/bulk", adminBulkRoute\);/);
});

test("every staff campaign write is refused on the server, not only hidden", () => {
  assert.match(STAFF, /if \(c\.req\.method !== "GET"\) return c\.json\(\{ error: STAFF_BULK_OFF \}, 403\);/);
  for (const path of ["/campaigns", "/campaigns/*", "/quick-message", "/templates", "/templates/*", "/channel/*"]) {
    assert.ok(STAFF_BULK_PATHS.includes(path), path);
  }
});

test("the refusal names its paths, so my-desk and my-day under /api/my keep working", () => {
  assert.ok(!STAFF_BULK_PATHS.includes("*"));
  assert.ok(!STAFF_BULK_PATHS.some((path) => path.startsWith("/clients") || path.startsWith("/day")));
});

test("an admin send reaches only this business's customers, narrowed by the ticked ids", () => {
  const send = ADMIN.slice(ADMIN.indexOf('adminBulkRoute.post("/:slug/send"'), ADMIN.indexOf('adminBulkRoute.post("/:slug/quick"'));
  assert.match(send, /getContactsForAudience\(organization\.id, \{\}\)/);
  assert.match(send, /customers\.filter\(\(customer\) => chosen\.has\(customer\.id\)\)/);
  assert.match(send, /if \(health\?\.problem\)/);
  assert.match(send, /if \(refused\)/);
});

test("the number must be one of the business's connected numbers", () => {
  assert.match(ADMIN, /That number is not one of this business's connected numbers\./);
  assert.match(ADMIN, /template\.whatsappBusinessAccountId !== number\.wabaId/);
});

test("a quick message from an admin still keeps WhatsApp's 24-hour rule", () => {
  const quick = ADMIN.slice(ADMIN.indexOf('adminBulkRoute.post("/:slug/quick"'), ADMIN.indexOf('adminBulkRoute.post("/:slug/test"'));
  assert.match(quick, /openWindowConversations\(organization\.id, number\.phoneNumberId/);
  assert.match(quick, /sendReplyOnChannel\(/);
});

test("the rail offers Bulk messaging to admins and no longer offers My campaigns", () => {
  assert.match(NAV, /href: "\/deck\/bulk",\s*label: "Bulk messaging"/);
  assert.doesNotMatch(NAV, /href: "\/deck\/my-campaigns"/);
  const entry = NAV.slice(NAV.indexOf('href: "/deck/bulk"'), NAV.indexOf('href: "/deck/bulk"') + 900);
  assert.match(entry, /operatorOnly: true/);
});
