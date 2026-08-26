/**
 * The owner's own dashboard shows only what the platform actually sent.
 *
 * ============================================================
 * THREE ROUNDS OF THE SAME DEFECT IN ONE FILE
 * ============================================================
 *
 * deck-console.tsx has been corrected for this three times, and each round its
 * own comment records the previous one:
 *
 *   1. Five invented conversations in the activity feed. Removed, with the note
 *      "Empty on purpose."
 *   2. Six invented statistics above them — "128 active conversations", "87% AI
 *      resolution", "1,402 messages today". Removed on 2026-08-2x, and the
 *      header comment observes that somebody "had already noticed half of it"
 *      and fixed the feed while leaving the numbers.
 *   3. Found 2026-08-26, and it is the same sentence again: the statistics were
 *      fixed and these were left —
 *
 *        a conversations chart drawn from [46, 58, 52, 74, 68, 88, 102],
 *        hardcoded, rendered unconditionally, never a fallback;
 *        a green "+18%" growth pill beside it;
 *        four governance rows reading "3 held", "low · 94%", "6" escalated —
 *        attributed by name to Juris Prime Legal — and "100%" coverage, each
 *        with a meter drawn to match.
 *
 * The platform has had seventeen conversations in its entire existence and zero
 * escalations. This is the owner's private dashboard: those numbers were
 * presented to them as their own business's performance.
 *
 * So this file exists to make the fourth round fail in CI rather than be found
 * by reading.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const CONSOLE_RAW = readFileSync(join(root, "apps", "web", "app", "deck-console.tsx"), "utf8");
const CONSOLE = withoutComments(CONSOLE_RAW);

// ============================================================
// The specific figures that were there
// ============================================================

test("the invented series is gone and has not come back", () => {
  // The exact array, because it is the thing that was rendered. A test for the
  // general shape follows; this one is the receipt.
  assert.ok(
    !CONSOLE.includes("46, 58, 52, 74, 68, 88, 102"),
    "the hardcoded conversations trend is back"
  );
});

test("no chart is drawn from a literal series", () => {
  // The general shape. A run of four or more numbers in an array, inside the
  // component, is a plotted claim — there is no other reason for one here.
  const arrays = [...CONSOLE.matchAll(/\[\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+[^\]]*\]/g)];
  assert.deepEqual(
    arrays.map((m) => m[0].slice(0, 40)),
    [],
    "a literal series is being plotted on the owner's dashboard"
  );
});

test("the growth pill is not a number nothing computed", () => {
  assert.ok(!CONSOLE.includes("+18%"), "the invented growth figure is back");
  // And nothing else states a bare percentage as a fact in the markup.
  const percents = [...CONSOLE.matchAll(/>\s*[+-]?\d{1,3}%\s*</g)];
  assert.deepEqual(
    percents.map((m) => m[0].trim()),
    [],
    "a percentage is written into the markup rather than sent by the platform"
  );
});

test("no governance row carries a hardcoded value", () => {
  // val="3 held", val="low · 94%", val="6", val="100%". Each had a meter drawn
  // to match, which is a second claim in the same row.
  const hardcoded = [...CONSOLE.matchAll(/<GovRow[^>]*\sval="[^"]*"/g)];
  assert.deepEqual(
    hardcoded.map((m) => m[0].slice(0, 70)),
    [],
    "a governance figure is written into the page instead of received"
  );
});

test("no business is named beside a figure it did not produce", () => {
  // "Juris Prime Legal · strict tier" sat under an invented escalation count.
  // Attributing an invented number to a NAMED business is the worst version of
  // this, because it reads as a specific finding about a specific firm.
  assert.ok(
    !CONSOLE.includes("Juris Prime Legal · strict tier"),
    "an invented figure is attributed to a named business"
  );
});

// ============================================================
// What it does instead
// ============================================================

test("an absent value renders as an em dash, not as zero", () => {
  // Zero is a measurement. "We did not receive one" is not, and drawing it as
  // zero is how /deck/quality rendered an outage as a healthy dashboard.
  assert.ok(CONSOLE.includes('val ?? "—"'), "an absent governance value is not shown as unknown");
  assert.ok(
    CONSOLE.includes("val: string | null"),
    "GovRow cannot express the difference between zero and unknown"
  );
});

test("the meter is not drawn under an unknown value", () => {
  // A bar at 94% beside an em dash reads as 94% to anybody glancing, which is
  // most people. The meter is a claim too.
  assert.ok(
    CONSOLE.includes("val === null ? null :"),
    "a meter is drawn for a value the platform never sent"
  );
});

test("the empty chart says which silence it is", () => {
  // An empty chart with no caption is indistinguishable from one that failed to
  // load — the confusion this console has now been corrected for three times.
  assert.ok(CONSOLE.includes("chart-empty"), "the empty chart carries no caption");
  assert.ok(
    CONSOLE_RAW.includes("could not be reached"),
    "the caption does not distinguish an outage from an empty platform"
  );
});

test("the chart still draws when a real series arrives", () => {
  // The fix must not be "delete the chart". The panel keeps its label and its
  // shape, and the moment something passes a series it renders — which is what
  // the header argues for: an empty dashboard should still say what it would
  // show.
  assert.ok(CONSOLE.includes("if (vals.length < 2) return null"), "the chart can no longer draw");
  assert.ok(CONSOLE.includes("{area ? ("), "the chart render is not guarded on having data");
});
