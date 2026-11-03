/**
 * Bulk sends from the admins' own numbers only (3 Nov 2026): when a business
 * has none, the page says how an admin gets one there — not that staff should.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("an empty sender list tells an admin how to add theirs", () => {
  const page = read("app/deck/bulk/page.tsx");
  assert.match(page, /No admin number is connected for this business yet\./);
  assert.match(page, /open Connections, choose this business under &quot;Connect for&quot;/);
  assert.doesNotMatch(page, /A staff member connects theirs in Connections/);
});
