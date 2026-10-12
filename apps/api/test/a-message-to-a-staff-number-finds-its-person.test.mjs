// A message to a staff member's own number finds its person.
//
// FOUND ON 12 OCT 2026, THE FIRST TIME IT EVER HAPPENED. +971 52 563 1476 was
// connected by Coexistence to a staff member; a customer wrote to it; Meta
// delivered it and the webhook accepted it — and the worker threw on every
// retry: `Query touched tenant-scoped table "employees" with no tenant context`
// at findEmployeeByPhoneNumberId. Its comment said it "runs in the webhook's
// cross-tenant context", but the WORKER has no context at all, and under
// DB_TENANT_ASSERT=strict an unscoped read of `employees` throws. Nothing
// reached the inbox.
//
// The lookup is the question "which business is this?", so it cannot run inside
// a business — it names its cross-tenant reason. One fix covers its three
// callers: a customer's message, the staff member's own reply typed on the
// phone (the echo), and delivery receipts for what they sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const DB = read("packages", "db", "src", "employees.ts");
const PROC = read("apps", "api", "src", "queue", "processor.ts");

function body() {
  const at = DB.indexOf("export async function findEmployeeByPhoneNumberId(");
  assert.ok(at > -1);
  return DB.slice(at, DB.indexOf("\n}\n", at));
}

test("finding whose number it is crosses businesses on purpose, and says why", () => {
  assert.match(body(), /withAllTenants\("[^"]+", /);
});

test("all three paths that ask it are covered by that one fix", () => {
  const calls = PROC.match(/findEmployeeByPhoneNumberId\(phoneNumberId\)/g) ?? [];
  assert.equal(calls.length, 3, "message, echo, receipts");
  assert.ok(!/withAllTenants\([^)]*\)\s*=>\s*findEmployeeByPhoneNumberId/.test(PROC), "no caller has to remember to wrap it");
});
