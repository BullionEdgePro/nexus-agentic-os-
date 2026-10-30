/**
 * Admins add client numbers straight into a campaign (30 Oct 2026).
 *
 * WhatsApp requires that people agreed to hear from the business, and spam
 * reports cost the sending number its rating — so the whole request is refused
 * without the consent tick, before a single number is written. The page
 * completes local numbers; the server takes nothing but the finished
 * international form, so a client bug can never store "0501234567".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { internationalWaIdRefusal, rowFailure } from "../src/routes/admin-bulk-customers.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

test("only international digits get through", () => {
  assert.equal(internationalWaIdRefusal("971501234567"), null);
  for (const bad of ["0501234567", "12345", "9715012345678901", "+971501234567", "97150abc"]) {
    assert.ok(internationalWaIdRefusal(bad), bad);
  }
});

test("consent is checked before a single number is written", () => {
  const route = read("apps", "api", "src", "routes", "admin-bulk-customers.ts");
  assert.ok(route.indexOf("consent !== true") < route.indexOf("ensureContactForServingBusiness("));
  assert.match(route, /rows\.length > 2000/);
  assert.match(route, /isWaIdOptedOut\(/);
  assert.match(route, /if \(number\.ownerEmployeeId\)[\s\S]{0,200}assignContactOwnerIfUnowned\(/);
  assert.match(route, /consent: true/); // in the log line
});

test("the route is mounted under the admin-only prefix", () => {
  assert.match(read("apps", "api", "src", "index.ts"), /app\.route\("\/api\/bulk", adminBulkCustomersRoute\);/);
});

test("a database error stops the whole add, because it rolled back everything before it", () => {
  // Each request is one transaction: after a Postgres error every earlier row
  // is rolled back at the end, so reporting them as "added" would be false.
  const dbError = Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" });
  assert.deepEqual(rowFailure(dbError), { stop: true, reason: "duplicate key value violates unique constraint" });
  assert.deepEqual(rowFailure(new Error("That does not look like a WhatsApp number.")), {
    stop: false,
    reason: "That does not look like a WhatsApp number.",
  });
  assert.deepEqual(rowFailure("boom"), { stop: false, reason: "Could not add that number." });
  const route = read("apps", "api", "src", "routes", "admin-bulk-customers.ts");
  assert.match(route, /if \(failure\.stop\)[\s\S]{0,400}Nothing was added/);
});
