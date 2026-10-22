// A WhatsApp campaign goes only to people with a WhatsApp number.
//
// FOUND 22 OCT 2026, on the first real staff campaign: Ralph sent
// zipicka_order_update to his book of 57 — and all 57 were EMAIL customers
// (his mailbox syncs into his book), with no wa_id. Every send went to Meta with
// an empty "to", Meta refused the first fourteen ("The parameter to is
// required"), and the circuit breaker paused it with 43 unsent. Nobody received
// it. The readiness check had also counted those 57 as "clients with WhatsApp".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BOOK = readFileSync(join(here, "..", "..", "..", "packages", "db", "src", "client-book.ts"), "utf8");

test("the campaign audience excludes anyone without a WhatsApp number", () => {
  const fn = BOOK.slice(BOOK.indexOf("export async function myClientsForBroadcast"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.match(body, /coalesce\(ct\.wa_id, ''\) <> ''/);
});
