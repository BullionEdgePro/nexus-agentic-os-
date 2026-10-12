// The server's own checks tell the truth (audit, 12 Oct 2026: verify-all.sh
// failed 2 of 12 gates while the live system was healthy).
//
// 1. schema-drift-check builds the schema from scratch (schema.sql, then every
//    migration in order) and 088 stopped it: schema.sql already carries
//    contacts.channel, and 088 added it without "if not exists". Production was
//    fine — 088 ran there before the snapshot caught up — but a rebuild or a
//    disaster restore would stop at 088. Every statement in it is re-runnable now.
// 2. self-check counted the businesses and expected exactly five. The sixth is
//    review-demo, the sandbox Meta's App Reviewer signs in to (2 Oct 2026) — a
//    real row on purpose, not a business. The check counts the businesses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const M088 = read("packages", "db", "migrations", "088-a-contact-need-not-have-a-phone.sql");
const SELF = read("apps", "api", "src", "scripts", "self-check.ts");

test("088 can run on a schema that already has what it adds", () => {
  const code = M088.replace(/--.*$/gm, "");
  assert.ok(!/add column (?!if not exists)/.test(code), "every add column says if not exists");
  assert.match(code, /create unique index if not exists contacts_external_identity_key/);
  assert.match(code, /drop constraint if exists contacts_has_identity;\s*alter table contacts add constraint contacts_has_identity/);
});

test("the business count leaves out the App Review sandbox", () => {
  assert.match(SELF, /\.filter\(\(o\) => o\.slug !== "review-demo"\)/);
  assert.match(SELF, /check\("all five businesses active", realBusinesses\.length === 5/);
});

// 3. A waiting customer with no phone number was named "+null": the email,
//    Facebook and Instagram customers since 30 Sep have no wa_id, and the
//    finding title fell back to `+${wa_id}`. 12 of 40 open findings read
//    "+null has been waiting 235 hours" (12 Oct 2026). They are named by the
//    address or handle they wrote from instead.
const OPS = read("apps", "api", "src", "services", "operators.ts");

test("a waiting customer without a phone number is named by how they wrote", () => {
  assert.match(OPS, /function customerLabel\(/);
  assert.match(OPS, /row\.contact_name \?\? \(row\.wa_id \? `\+\$\{row\.wa_id\}` : row\.external_id \?\? "A customer"\)/);
  assert.equal((OPS.match(/customerLabel\(row\)/g) ?? []).length, 3, "every finding that names a customer uses it");
  assert.ok(!/contact_name \?\? `\+\$\{row\.wa_id\}`/.test(OPS), "the bare +wa_id fallback is gone");
  assert.equal((OPS.match(/ct\.external_id,/g) ?? []).length, 2, "both queries read the address");
});
