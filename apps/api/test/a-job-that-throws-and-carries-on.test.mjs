// Sixteen runs, two failures, and nothing said a word.
//
// `schedule-stalled` judges last_finished_at, which only advances on success.
// That catches a job failing EVERY time: the finish freezes, the window runs
// out, the finding fires. It cannot catch a job failing INTERMITTENTLY, because
// every success moves the finish forward again and the window never runs out.
//
// knowledge-reindex is exactly that shape. Measured on production 2026-08-21:
// runs 16, failures 2, and no finding was ever raised for either. Both were the
// tenant-scope assert firing inside the ingest path; both were found by
// somebody reading job_heartbeats by hand, three days later. In between, the
// knowledge base was refreshed from whatever survived and a changed page was
// answered from the old copy, with a citation attached.
//
// I ALSO GOT THIS WRONG FIRST. The heartbeat carried an error and read as
// broken. It had failed on the 18th, been fixed, and succeeded on every run
// since — `last_error` is deliberately sticky, so its PRESENCE says nothing
// about now. Only last_error_at compared against last_finished_at settles it,
// which is why this operator reads timestamps and not the message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { hasJobFailedRecently, JOB_STALE_AFTER_SECONDS } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const WHERE = read("apps", "web", "app", "deck", "operators", "where-to-fix-it.ts");
const HEARTBEATS = read("packages", "db", "src", "heartbeats.ts");

const NOW = new Date("2026-08-21T16:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000);

test("a job that has never failed is not reported", () => {
  assert.equal(hasJobFailedRecently("knowledge-reindex", null, NOW), false);
});

test("a failure inside two windows is recent; outside is not", () => {
  // knowledge-reindex's window is 18h, so two windows is 36h.
  const window = JOB_STALE_AFTER_SECONDS["knowledge-reindex"] / 3600;
  assert.equal(window, 18);
  assert.equal(hasJobFailedRecently("knowledge-reindex", hoursAgo(1), NOW), true);
  assert.equal(hasJobFailedRecently("knowledge-reindex", hoursAgo(35), NOW), true);
  assert.equal(hasJobFailedRecently("knowledge-reindex", hoursAgo(37), NOW), false);
});

test("the real production row does not fire", () => {
  // THE CASE THAT NEARLY PRODUCED A FALSE ALARM. This is the actual heartbeat
  // as measured: last error 2026-08-18 12:00:30, last finish 2026-08-21
  // 12:00:07. Three days apart. The job recovered and this must stay silent, or
  // the operator is a permanent red light nobody can turn off.
  assert.equal(
    hasJobFailedRecently("knowledge-reindex", new Date("2026-08-18T12:00:30Z"), NOW),
    false
  );
});

test("two windows, not one", () => {
  // One window would retract the moment the next run succeeded — which for an
  // intermittent fault is exactly when it is still true, because succeeding in
  // between is the whole shape of the thing.
  const src = read("packages", "shared", "src", "schedule.ts");
  const fn = src.slice(src.indexOf("export function hasJobFailedRecently"));
  assert.match(fn.slice(0, fn.indexOf("\n}")), /\* 2;/);
});

test("it defers to schedule-stalled when the job has stopped outright", () => {
  // A job failing every time is stalled, and that is the other operator's
  // finding. Raising both would put two rows on the deck for one fault, and
  // fixing it would retract only half of them.
  const body = OPERATORS.slice(
    OPERATORS.indexOf("const jobFailing: Operator = {"),
    OPERATORS.indexOf("const scheduleStalled: Operator = {")
  );
  assert.match(body, /return !isJobStalled\(/);
});

test("it reads the timestamp, never the sticky message", () => {
  const body = OPERATORS.slice(
    OPERATORS.indexOf("const jobFailing: Operator = {"),
    OPERATORS.indexOf("const scheduleStalled: Operator = {")
  );
  // The message may still be shown as context; what must not happen is
  // BRANCHING on its presence.
  assert.ok(
    !/if \(beat\.lastError\)|beat\.lastError !== null|beat\.lastError != null/.test(body),
    "branching on last_error makes a permanent red light: it survives every later success"
  );
  assert.match(body, /hasJobFailedRecently\(/);

  // And the stickiness this depends on must stay stated at the source.
  assert.match(HEARTBEATS, /kept rather than cleared by a later success/);
});

test("the operator sweep does not testify to its own liveness", () => {
  // Same exclusion schedule-stalled makes, for the same reason: this runs
  // inside the sweep, so it cannot report that the sweep is failing.
  const body = OPERATORS.slice(
    OPERATORS.indexOf("const jobFailing: Operator = {"),
    OPERATORS.indexOf("const scheduleStalled: Operator = {")
  );
  assert.match(body, /beat\.job === "operators"/);
});

test("it is registered and has somewhere to send a reader", () => {
  assert.match(OPERATORS, /\n  jobFailing,/);
  assert.match(WHERE, /"job-failing": \{ screen: "operators" \}/);
  // A job is not a row, so the finding must not claim a subject id — the deck
  // would build a link to a record that does not exist.
  const body = OPERATORS.slice(
    OPERATORS.indexOf("const jobFailing: Operator = {"),
    OPERATORS.indexOf("const scheduleStalled: Operator = {")
  );
  assert.match(body, /subjectId: null/);
});

test("the finding says how it clears itself", () => {
  // A warn that a reader cannot make go away is a warn they learn to ignore.
  const body = OPERATORS.slice(
    OPERATORS.indexOf("const jobFailing: Operator = {"),
    OPERATORS.indexOf("const scheduleStalled: Operator = {")
  );
  assert.match(body, /clears itself once two of this job's intervals pass/);
});
