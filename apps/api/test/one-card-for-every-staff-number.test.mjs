/**
 * 30 Oct 2026: the owner wants every staff member's campaigns paid by one card,
 * to pick exactly which clients a message goes to, and to know who removed staff.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { chosenIds } from "../src/routes/my-campaigns.ts";
import { wrongBusinessWarning } from "../src/lib/main-business.ts";
import { healthFrom } from "../src/lib/whatsapp-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", "src", ...p), "utf8");
const EMPLOYEES = src("routes", "employees.ts");
const CAMPAIGNS = src("routes", "my-campaigns.ts");

const main = { id: "3509450049200127", name: "sfsintlrealestate786", setBy: "Ralph", at: "2026-10-30T00:00:00Z" };

test("a number in another business is told to reconnect into the main one, by name", () => {
  assert.match(wrongBusinessWarning(main, "352324582262751"), /choose “sfsintlrealestate786”/);
  assert.equal(wrongBusinessWarning(main, "3509450049200127"), null);
  assert.equal(wrongBusinessWarning(main, null), null, "Meta not saying is not a wrong business");
});

test("the health answer names the business and account a number bills to", () => {
  const health = healthFrom({
    can_send_message: "LIMITED",
    entities: [
      { entity_type: "WABA", id: "1915340836093863", can_send_message: "AVAILABLE" },
      { entity_type: "BUSINESS", id: "3509450049200127", can_send_message: "LIMITED" },
    ],
  });
  assert.equal(health.businessId, "3509450049200127");
  assert.equal(health.wabaId, "1915340836093863");
});

test("the setup checklist and the main business are the owner's alone", () => {
  for (const marker of ['employeesRoute.get("/:slug/whatsapp-setup"', 'employeesRoute.post("/:slug/whatsapp-setup/main-business"']) {
    const at = EMPLOYEES.indexOf(marker);
    assert.ok(at > 0, marker);
    assert.match(EMPLOYEES.slice(at, at + 400), /scopeOf\(c\)\.role !== "operator"/);
  }
});

test("chosen clients are only ever a subset of the book", () => {
  assert.equal(chosenIds(undefined), null);
  assert.deepEqual([...chosenIds(["a", 7, "b", null])], ["a", "b"]);
  assert.match(CAMPAIGNS, /const audience = chosen \? wholeBook\.filter\(\(person\) => chosen\.has\(person\.id\)\) : wholeBook;/);
  assert.match(CAMPAIGNS, /const book = chosen \? wholeBook\.filter\(\(person\) => chosen\.has\(person\.id\)\) : wholeBook;/);
});

test("removing and restoring record who clicked", () => {
  assert.match(EMPLOYEES, /if \(changed\) await recordStaffChange\(employee\.id, \{ action: "removed", byId: actor\.id, byName: actor\.name \}\)/);
  assert.match(EMPLOYEES, /if \(restored\) await recordStaffChange\(employee\.id, \{ action: "restored"/);
  assert.match(EMPLOYEES, /removedBy: change\?\.action === "removed" \? change\.byName : null/);
});

test("a connect outside the main business is warned about straight away", () => {
  const connections = src("routes", "connections.ts");
  assert.match(connections, /const businessWarning = main \? wrongBusinessWarning\(main, health\?\.businessId \?\? null\) : null;/);
});
