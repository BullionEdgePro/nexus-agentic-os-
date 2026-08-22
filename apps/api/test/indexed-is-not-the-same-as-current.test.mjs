// Every source said `indexed`, every job said success, and a fifth of the
// platform's pages were over a day old.
//
// Three operators already watch the knowledge pipeline and all three were green
// on 2026-08-22 while 20 of juris-prime-legal's 25 pages had not been re-read in
// 28 hours:
//
//   broken-knowledge   watches sources marked FAILED — all 65 were `indexed`
//   schedule-stalled   watches the re-index stopping — it was running
//   job-failing        watches it throwing — it was not
//
// None of them watches the outcome those three exist to protect: whether the
// pages the agent answers from are actually current. A page can be perfectly
// indexed and a week out of date, and the reply cites it either way.
//
// The starvation is silent by construction. The sweep takes the twenty stalest
// sources platform-wide every six hours — eighty a day against sixty-five
// sources, so it keeps up today. One more business with a forty-page site
// removes the headroom, and nothing about onboarding announces that.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  knowledgeRefreshBoundHours,
  knowledgeRefreshCapacityPerDay,
  KNOWLEDGE_STALE_AFTER_HOURS,
  KNOWLEDGE_REINDEX_INTERVAL_HOURS,
  KNOWLEDGE_SOURCES_PER_RUN,
} from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const QUEUE = read("apps", "api", "src", "queue", "reindex-queue.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "reindex-processor.ts");

function operator() {
  const from = OPERATORS.indexOf("const knowledgeNotRefreshing: Operator = {");
  const to = OPERATORS.indexOf("const brokenKnowledge: Operator = {", from);
  assert.ok(from > -1 && to > from, "knowledgeNotRefreshing is gone");
  return OPERATORS.slice(from, to);
}

test("the bound is the designed worst case, derived from the schedule", () => {
  // A source becomes eligible at the threshold and then waits up to one
  // interval for the next run. Threshold + interval is therefore the oldest a
  // source should ever be while the sweep is keeping up.
  assert.equal(knowledgeRefreshBoundHours(), KNOWLEDGE_STALE_AFTER_HOURS + KNOWLEDGE_REINDEX_INTERVAL_HOURS);
  assert.equal(knowledgeRefreshBoundHours(), 30);
});

test("the measured production value sits inside the bound", () => {
  // THE NUMBER THAT WOULD HAVE MADE THIS A FALSE ALARM. The oldest source on
  // production the day this was written was 28.5 hours — healthy, and under a
  // threshold picked by eye it would very likely have fired.
  assert.ok(28.5 < knowledgeRefreshBoundHours(), "28.5h must read as healthy");
  // And the operator doubles the bound, so a single late cycle is not an alarm.
  assert.match(operator(), /knowledgeRefreshBoundHours\(\) \* 2/);
  assert.ok(28.5 < knowledgeRefreshBoundHours() * 2);
});

test("capacity is computed from the same two numbers the sweep uses", () => {
  assert.equal(
    knowledgeRefreshCapacityPerDay(),
    KNOWLEDGE_SOURCES_PER_RUN * (24 / KNOWLEDGE_REINDEX_INTERVAL_HOURS)
  );
  assert.equal(knowledgeRefreshCapacityPerDay(), 80);
});

test("the interval is defined once and imported, never copied", () => {
  // Two independent 6s drift the first time somebody tunes one. The queue that
  // REGISTERS the schedule and the operator that JUDGES it must read the same
  // constant.
  assert.match(QUEUE, /KNOWLEDGE_REINDEX_INTERVAL_HOURS \* 60 \* 60 \* 1000/);
  assert.match(PROCESSOR, /const SOURCES_PER_RUN = KNOWLEDGE_SOURCES_PER_RUN;/);
  assert.match(PROCESSOR, /const STALE_AFTER_HOURS = KNOWLEDGE_STALE_AFTER_HOURS;/);
  assert.ok(
    !/const EVERY_SIX_HOURS_MS = 6 \* 60/.test(QUEUE),
    "the queue is back to its own hardcoded interval"
  );
});

test("the interval is not inferred from the stall tolerance", () => {
  // It was, briefly. JOB_STALE_AFTER_SECONDS happens to be three intervals for
  // this job, and dividing by three to recover the interval reads a coincidence
  // as a contract — the tolerances are explicitly "roughly three intervals for
  // the frequent jobs and a generous margin for the daily ones", so the ratio
  // is neither uniform nor promised.
  const schedule = read("packages", "shared", "src", "schedule.ts");
  const fns = schedule.slice(schedule.indexOf("export function knowledgeRefreshBoundHours"));
  assert.ok(
    !/JOB_STALE_AFTER_SECONDS\[.knowledge-reindex.\]\s*\/\s*3600\s*\/\s*3/.test(fns),
    "the interval is being recovered from the tolerance again"
  );
});

test("it says the fix is not inside the business it is raised against", () => {
  // The finding lands on each business's deck because the CONSEQUENCE is
  // theirs, but the cause is one shared sweep and one shared quota. A finding
  // that reads as "your fault" when nobody in that business can act on it is
  // one they learn to skip.
  const body = operator();
  assert.match(body, /countKnowledgeSourcesAcrossPlatform/);
  assert.match(body, /pages on the platform and the sweep can revisit/);
  assert.match(body, /schedule runs more often or fewer pages are tracked/);
});

test("it distinguishes out-of-capacity from something else going wrong", () => {
  // Over capacity is arithmetic and needs a schedule change. Under capacity
  // with pages still ageing is a run that failed or a site that stopped
  // responding — a different action entirely.
  const body = operator();
  assert.match(body, /estate > capacity/);
  assert.match(body, /within capacity/);
});

test("it says nothing is failing, because nothing is", () => {
  // The reader's first instinct on a knowledge warning is to look for a broken
  // source. Saying plainly that none is broken is what stops that search.
  assert.match(operator(), /Nothing is failing/);
  assert.match(operator(), /still reports as indexed/);
});

test("it is registered beside broken-knowledge and has a destination", () => {
  assert.match(OPERATORS, /\n  knowledgeNotRefreshing,/);
  const where = read("apps", "web", "app", "deck", "operators", "where-to-fix-it.ts");
  assert.match(where, /"knowledge-not-refreshing": \{ screen: "knowledge" \}/);
});
