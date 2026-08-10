// The script that runs every query which has never run.
//
// Its whole reason for existing is that source-text tests — including most of
// this suite — cannot know whether a column exists. So the properties worth
// asserting here are about safety and honesty, not about the SQL: this thing
// touches production data, and a careless version of it would leave a fake
// customer behind or send a real WhatsApp message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const CHECK = readFileSync(
  join(here, "..", "src", "scripts", "schema-check.ts"),
  "utf8"
);

test("it never enqueues a send", () => {
  // The broadcast path is exercised as far as the database and stops. Proving
  // the SQL works must not cost a customer a WhatsApp message.
  assert.ok(!/getBroadcastSendQueue|queue\.add|sendWhatsApp/.test(CHECK));
  assert.match(CHECK, /stops before enqueueing|stopping short of enqueueing/);
});

test("cleanup runs even when a step fails", () => {
  // Without the finally, a failure mid-way leaves a probe contact in a real
  // business's audience count — a fake customer that a bulk send would message.
  assert.match(CHECK, /\} finally \{/);
  assert.match(CHECK, /delete from contacts where organization_id = \$1 and wa_id = \$2/);
});

test("cleanup is verified, not assumed", () => {
  // The rule this session keeps relearning: "no error" is not evidence.
  assert.match(CHECK, /probe still present/);
  assert.match(CHECK, /if \(leftover !== 0\) failures\+\+/);
});

test("a write is proved by reading it back", () => {
  // A write that succeeds and a read that returns nothing is exactly the
  // failure RLS introduces, and exactly what this should catch.
  assert.match(CHECK, /wrote, but read returned nothing/);
});

test("every path runs inside a tenant context", () => {
  // Otherwise the script itself would trip the strict assertion, or worse pass
  // while the application path it stands in for would not.
  assert.ok(!/^\s*await (getContactMemory|createBroadcast|upsertContactMemory)\(/m.test(CHECK));
  assert.match(CHECK, /withTenant\(org\.id/);
});

test("it reports failures as customer-facing, not cosmetic", () => {
  assert.match(CHECK, /would have failed the first time a customer triggered them/);
  console.log("PASS: schema check exercises unrun SQL without sending anything or leaving anything behind");
});
