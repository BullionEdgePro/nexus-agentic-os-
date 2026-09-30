// A chat's history (assignments, handovers, calls) is sorted by time. The
// database driver returns Date objects for timestamps even where the types say
// string, and the sort called .localeCompare on them — so any chat with two or
// more history items failed to open (production log, 2026-09-30). Pinned as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = readFileSync(join(here, "..", "src", "routes", "conversations.ts"), "utf8").replace(/\r\n/g, "\n");

test("every timeline time is normalised before the sort", () => {
  const at = ROUTE.indexOf("async function buildTimeline(");
  assert.ok(at > -1, "buildTimeline moved");
  const fn = ROUTE.slice(at, ROUTE.indexOf("\n}\n", at));
  assert.match(fn, /at: iso\(e\.createdAt\)/);
  assert.match(fn, /at: iso\(ev\.createdAt\)/);
  assert.match(fn, /at: iso\(call\.occurredAt\)/);
  assert.match(ROUTE, /value instanceof Date \? value : new Date\(value\)/);
});
