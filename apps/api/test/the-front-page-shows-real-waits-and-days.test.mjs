// The admin front page's real numbers (2 Nov 2026, Cream pages 2a).
//
// The redesigned front page shows the customers waiting longest as coloured
// cards and draws conversations per day. Both from data Nexus already holds:
// the same waiting list Staff work uses (now every wait, not only those over
// two hours), and the nightly per-business rollup in agent_quality_daily.
// Spec: docs/superpowers/specs/2026-11-02-cream-pages-2a-design.md §2
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { zeroFillDays } from "../../../packages/db/src/days.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("every one of the last days is there, missing days as zero", () => {
  const out = zeroFillDays([{ day: "2026-10-30", conversations: 4 }], "2026-11-01", 3);
  assert.deepEqual(out, [
    { day: "2026-10-30", conversations: 4 },
    { day: "2026-10-31", conversations: 0 },
    { day: "2026-11-01", conversations: 0 },
  ]);
  // Across a month end, and summing nothing it was not given.
  assert.deepEqual(
    zeroFillDays([], "2026-03-01", 2).map((d) => d.day),
    ["2026-02-28", "2026-03-01"]
  );
});

test("the six longest waits of any length, oldest first, and the total", () => {
  const SW = read("packages", "db", "src", "staff-work.ts");
  assert.match(SW, /oldestWaiting: \[\.\.\.waiting\]\s*\.sort\([\s\S]{0,80}?\)\)\s*\.slice\(0, 6\)/);
  assert.match(SW, /waitingTotal: waiting\.length/);
  assert.match(SW, /o\.name as org_name/);
  assert.match(read("apps", "web", "lib", "api.ts"), /oldestWaiting: Array<\{/);
});

test("the overview carries the days, summed across businesses, to yesterday", () => {
  const M = read("packages", "db", "src", "metrics.ts");
  assert.match(M, /from agent_quality_daily/);
  assert.match(M, /day < current_date/);
  assert.match(M, /zeroFillDays\(/);
  assert.match(read("packages", "shared", "src", "types.ts"), /conversationsByDay: Array<\{ day: string; conversations: number \}>/);
});
