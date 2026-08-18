// "Nothing needs attention. Checked within the last ten minutes."
//
// That sentence was hardcoded prose on the operators deck. If the sweep stops,
// `operator_findings` stops changing, the count stays at zero, and the panel
// goes on reassuring somebody indefinitely — the exact failure migration 050
// exists to end, rendered as good news on the one screen whose entire job is to
// say what needs attention.
//
// `lastSeenAt` per operator could not fix it: that value comes from findings, so
// an operator which has never found anything is null forever whether or not it
// ran. Only the heartbeat records that the sweep HAPPENED.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

/**
 * Comments stripped before asserting what the page SAYS.
 *
 * The comment explaining why the old sentence was removed quotes it, so a plain
 * search finds the explanation and reports the sentence as still present. Block
 * comments are matched only where they start a line — see the same helper in
 * marketplace-installs-only.test.mjs for why the naive version eats string
 * literals.
 */
const rendered = (text) =>
  text.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, " ").replace(/^[ \t]*\/\/[^\n]*/gm, " ");

const ROUTE = read("apps", "api", "src", "routes", "operators.ts");
const PAGE = read("apps", "web", "app", "deck", "operators", "page.tsx");
const API = read("apps", "web", "lib", "api.ts");

test("the page no longer asserts its own freshness", () => {
  assert.ok(
    !rendered(PAGE).includes("Checked within the last ten minutes"),
    "the hardcoded claim must be gone, not merely joined by a real one"
  );
  assert.match(PAGE, /describeSweep\(sweep\.lastSweptAt\)/);
});

test("an empty list from a stopped sweep says something different", () => {
  // "Nothing found" and "nothing looked" are different facts, and this is the
  // screen where confusing them costs the most.
  assert.match(PAGE, /sweep\.stalled \?/);
  assert.match(PAGE, /Nothing has been checked recently/);
  assert.match(PAGE, /not because there is\s*\n?\s*nothing wrong/);
});

test("never having run is stated bluntly rather than softened", () => {
  // Every gentler wording reads as a note about a quiet period. This one has to
  // stop a reader skimming past it.
  assert.match(PAGE, /has not completed once since the worker started/);
});

test("the freshness comes from the heartbeat, not from the findings", () => {
  assert.match(ROUTE, /listJobHeartbeats\(\)/);
  assert.match(ROUTE, /beat\.job === "operators"/);
  assert.match(ROUTE, /lastSweptAt = sweep\?\.lastFinishedAt \?\? null/);

  // A failure reading heartbeats must not take out the findings page, which is
  // useful with or without this field.
  assert.match(ROUTE, /listJobHeartbeats\(\)\.catch\(\(\) => \[\]\)/);
});

test("the tolerance is not re-implemented in the browser", () => {
  // It lives in @nexus/shared beside the schedule it judges. A second copy in
  // the web app is a second thing to forget when the interval changes.
  assert.match(ROUTE, /isJobStalled\(\s*"operators"/);
  assert.ok(
    !/isJobStalled|JOB_STALE_AFTER_SECONDS/.test(PAGE),
    "the page must be told whether the sweep is stale, not work it out"
  );
  assert.match(API, /sweepStalled: boolean/);
});
