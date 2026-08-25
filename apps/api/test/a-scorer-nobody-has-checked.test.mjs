/**
 * Lead labels, and the accuracy figure that refuses to be computed too early.
 *
 * ============================================================
 * THE CONDITION NOBODY COULD REACH
 * ============================================================
 *
 * F3 has said "Model second once labels exist" since this platform started, and
 * nothing in it ever produced a label. The scorer is rules over keywords,
 * `lead_assessments` records what it decided, and there was nowhere to record
 * whether it was right — so the condition was unreachable by construction.
 *
 * What that actually cost is not the missing model. It is that a rules scorer
 * nobody has ever checked is indistinguishable from a good one, and it has been
 * ranking real customers for months.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { scorerAccuracy, isLeadOutcome, MIN_LABELS_PER_SIDE } from "@nexus/leads";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ROUTE = withoutComments(read("apps", "api", "src", "routes", "employees.ts"));
const STORE = read("packages", "leads", "src", "label-store.ts");
const MIGRATION = read(
  "packages",
  "db",
  "migrations",
  "067-what-the-lead-actually-turned-out-to-be.sql"
);

/** n labels at one priority, `worth` of them worth somebody's time. */
const labels = (priority, count, worth) =>
  Array.from({ length: count }, (_, i) => ({ priority, worthAttention: i < worth }));

const enough = (worthLoud, worthQuiet) => [
  ...labels("high", MIN_LABELS_PER_SIDE, worthLoud),
  ...labels("normal", MIN_LABELS_PER_SIDE, worthQuiet),
];

// ============================================================
// The refusal
// ============================================================

test("no labels at all produces no number and a sentence saying what to do", () => {
  const out = scorerAccuracy([]);
  assert.equal(out.falseAlarmRate, null);
  assert.equal(out.missRate, null);
  assert.ok(out.blockedBecause, "an empty set produced a figure");
  assert.match(out.blockedBecause, /more high-priority/, "the refusal must say what is missing");
});

test("a handful of labels is still a refusal", () => {
  // A rate computed from three labels has the shape of an accuracy figure and
  // none of the content, and somebody would act on it.
  const out = scorerAccuracy([...labels("high", 3, 1), ...labels("normal", 3, 0)]);
  assert.equal(out.falseAlarmRate, null);
  assert.equal(out.missRate, null);
  assert.ok(out.blockedBecause);
});

test("the sentence says how many more, not just 'not enough'", () => {
  // "Not enough data" tells nobody whether that means two more or two hundred,
  // and the fix here is entirely in the reader's hands.
  const out = scorerAccuracy([...labels("high", 2, 1), ...labels("normal", 1, 0)]);
  assert.match(out.blockedBecause, new RegExp(String(MIN_LABELS_PER_SIDE - 2)));
  assert.match(out.blockedBecause, new RegExp(String(MIN_LABELS_PER_SIDE - 1)));
});

test("one side being ready does not publish the other", () => {
  // THE HALF-ANSWER THAT WOULD BE WORST. Publishing the false-alarm rate while
  // the miss rate is still unknown reads as "the scorer is fine" — and the miss
  // rate is the expensive one.
  const out = scorerAccuracy([...labels("high", MIN_LABELS_PER_SIDE, 8), ...labels("normal", 2, 0)]);
  assert.equal(typeof out.falseAlarmRate, "number", "a side with enough labels should be reported");
  assert.equal(out.missRate, null);
  assert.ok(out.blockedBecause, "a partial answer must still say what is missing");
  assert.match(out.blockedBecause, /costs money/, "the missing side is the expensive one and should say so");
});

// ============================================================
// The maths, once it is allowed to speak
// ============================================================

test("a false alarm is a loud lead that was not worth it", () => {
  // 8 high, 6 worth it → 2 false alarms → 25%.
  const out = scorerAccuracy(enough(6, 0));
  assert.equal(out.blockedBecause, null);
  assert.equal(out.falseAlarmRate, 0.25);
  assert.equal(out.missRate, 0);
});

test("a miss is a quiet lead that WAS worth it", () => {
  // 8 normal, 2 of them worth somebody's time → 25% missed.
  const out = scorerAccuracy(enough(8, 2));
  assert.equal(out.missRate, 0.25);
  assert.equal(out.falseAlarmRate, 0);
});

test("urgent counts as loud and low counts as quiet", () => {
  // The scorer's four priorities collapse into two groups, and getting that
  // split wrong would silently move every urgent lead into the miss column.
  const out = scorerAccuracy([
    ...labels("urgent", MIN_LABELS_PER_SIDE, MIN_LABELS_PER_SIDE),
    ...labels("low", MIN_LABELS_PER_SIDE, 0),
  ]);
  assert.equal(out.loudCount, MIN_LABELS_PER_SIDE);
  assert.equal(out.quietCount, MIN_LABELS_PER_SIDE);
  assert.equal(out.falseAlarmRate, 0);
  assert.equal(out.missRate, 0);
});

test("the two failures are never averaged into one figure", () => {
  // A single "accuracy" would look fine while every miss is a customer who went
  // elsewhere. There must be no combined number to read by mistake.
  const out = scorerAccuracy(enough(4, 4));
  assert.ok(!("accuracy" in out), "a combined figure is back");
  assert.ok(!("score" in out), "a combined figure is back");
});

// ============================================================
// What may be stored
// ============================================================

test("an outcome nobody defined is refused rather than stored as free text", () => {
  // A column of near-synonyms is a column nothing can count.
  assert.equal(isLeadOutcome("won"), true);
  assert.equal(isLeadOutcome("not_a_lead"), true);
  assert.equal(isLeadOutcome("maybe"), false);
  assert.equal(isLeadOutcome(""), false);
  assert.equal(isLeadOutcome(null), false);
  assert.ok(ROUTE.includes("isLeadOutcome(body.outcome)"), "the route accepts any outcome string");
});

test("the label is required and the outcome is not", () => {
  // A label that demanded an outcome is a label nobody fills in, and the binary
  // is the part that carries the signal.
  assert.ok(
    ROUTE.includes('typeof body?.worthAttention !== "boolean"'),
    "a label can be recorded without saying what it is"
  );
  assert.match(MIGRATION, /worth_attention boolean not null/);
  assert.ok(
    /outcome\s+text check \(outcome is null or/.test(MIGRATION),
    "the outcome must be optional"
  );
});

test("a second opinion overwrites rather than counting twice", () => {
  // Two rows for one assessment would double that lead's weight in every count
  // that reads this table, and a disagreement between colleagues is a
  // conversation rather than a statistic.
  assert.match(MIGRATION, /lead_labels_one_per_assessment/);
  assert.ok(STORE.includes("on conflict (assessment_id) do update"));
});

test("a label is attributed to a person", () => {
  // This is training data for something that will later decide which customers
  // get attention.
  assert.match(MIGRATION, /labelled_by\s+text not null/);
  assert.ok(ROUTE.includes("labelledBy: scope.sub"));
});

test("a lead belonging to another business cannot be labelled", () => {
  // The insert selects the assessment by id AND organization, so a mistyped id
  // writes nothing rather than labelling somebody else's lead. RLS would stop
  // it too; this makes the intent readable without knowing that.
  assert.ok(
    STORE.includes("where a.id = $2 and a.organization_id = $1"),
    "the label is written without checking the assessment belongs to this business"
  );
  assert.ok(
    ROUTE.includes('"That lead is not available to mark."'),
    "a miss must be a 404 rather than a silent success"
  );
});

test("the maths is separate from the fetching", () => {
  // So the refusal can be tested without a database — which matters because the
  // refusal is the part that must not quietly stop working.
  const ACCURACY = read("packages", "leads", "src", "accuracy.ts");
  for (const forbidden of ["getPool", "await ", "query("]) {
    assert.ok(!ACCURACY.includes(forbidden), `accuracy.ts reaches for ${forbidden}`);
  }
});
