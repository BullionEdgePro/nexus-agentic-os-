// Nothing watched the watchers, and "0 standing findings" is what that looks like.
//
// Six things are scheduled at worker boot — operators (10m), quality rollup
// (hourly), template sync (30m), knowledge re-index (6h), procedure inference
// and forecast cycle (daily) — and every one is scheduled best-effort:
//
//     scheduleOperators()
//       .then(...)
//       .catch((err) => logger.warn({ err }, "Could not schedule operators"));
//
// That shape is right: a scheduling failure must not stop customer messages
// being answered. It also means any of the six can fail to register, or stop
// repeating, while the platform looks entirely healthy.
//
// The worst to lose is the operator sweep, because it is the alarm system. If it
// stops, all fifteen operators go quiet, operator_findings stops changing, and
// the deck reports 0 standing findings — indistinguishable from a platform with
// nothing wrong. Every silent failure this codebase has found would be invisible
// again, and the thing meant to catch them would be reporting good news.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  SCHEDULED_JOBS,
  JOB_STALE_AFTER_SECONDS,
  isJobStalled,
} from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const HEARTBEATS = read("packages", "db", "src", "heartbeats.ts");
const INDEX = read("apps", "api", "src", "index.ts");
const MIGRATION = read("packages", "db", "migrations", "050-job-heartbeats.sql");
const WORKER = read("apps", "api", "src", "worker.ts");

const PROCESSORS = {
  operators: read("apps", "api", "src", "queue", "operators-processor.ts"),
  "quality-rollup": read("apps", "api", "src", "queue", "quality-processor.ts"),
  "template-sync": read("apps", "api", "src", "queue", "template-sync-processor.ts"),
  "knowledge-reindex": read("apps", "api", "src", "queue", "reindex-processor.ts"),
  "procedure-inference": read("apps", "api", "src", "queue", "procedures-processor.ts"),
  "forecast-cycle": read("apps", "api", "src", "queue", "forecast-processor.ts"),
  "calendar-sync": read("apps", "api", "src", "queue", "calendar-sync-processor.ts"),
};

test("every scheduled job is watched, and the list is the one the worker schedules", () => {
  // A job added to the worker and forgotten here would be unwatched in exactly
  // the way this whole feature exists to prevent — so the assertion runs in
  // both directions rather than checking a hand-written count.
  assert.equal(SCHEDULED_JOBS.length, 7);

  for (const job of SCHEDULED_JOBS) {
    const source = PROCESSORS[job];
    assert.ok(source, `${job} has no processor mapped in this test`);
    assert.match(
      source,
      new RegExp(`withJobHeartbeat\\("${job}"`),
      `${job} runs without recording that it ran`
    );
    assert.ok(
      JOB_STALE_AFTER_SECONDS[job] > 0,
      `${job} has no tolerance, so nothing can call it late`
    );
  }

  // And the worker really does schedule seven things, best-effort. If that count
  // changes, one of these two lists is now wrong.
  const scheduled = WORKER.match(/^schedule[A-Za-z]+\(\)$/gm) ?? [];
  assert.equal(scheduled.length, 7, "the worker schedules a different number of jobs than are watched");
});

test("a job that started and never finished is a different fault from one that never started", () => {
  // The wrapper writes a start, then a finish. `last_started_at` moving without
  // `last_finished_at` following it means the job is HANGING rather than dead,
  // which has a different cause and a different fix.
  assert.match(HEARTBEATS, /last_started_at = now\(\)/);
  assert.match(HEARTBEATS, /last_finished_at = case when \$3::text is null then now\(\) else last_finished_at end/);

  // The wrapper takes the body rather than sitting beside the call, so a start
  // cannot be recorded without a matching finish by somebody adding an early
  // return later.
  assert.match(HEARTBEATS, /export async function withJobHeartbeat<T>\(job: ScheduledJob, work: \(\) => Promise<T>\)/);

  // And it rethrows: the caller's own retries and logging predate this and stay
  // in charge.
  assert.match(HEARTBEATS, /await markFinished\(job, Date\.now\(\) - startedAt, describe\(err\)\)[\s\S]{0,80}throw err;/);
});

test("a later success must not erase the last failure", () => {
  // A job that fails every other run is broken. A field showing only the most
  // recent outcome would show a green one half the time.
  assert.match(HEARTBEATS, /last_error = coalesce\(\$3, last_error\)/);
  assert.match(MIGRATION, /NOT cleared by a later success/);
});

test("a job that never registered has no row, and that is the case that matters", () => {
  // A scheduler that failed at boot writes nothing at all, so reading only what
  // exists would report five healthy jobs and no sign of the sixth. The known
  // job list has to be the LEFT side of the join.
  assert.match(HEARTBEATS, /from unnest\(\$1::text\[\]\) as j\(job\)\s*\n\s*left join job_heartbeats h on h\.job = j\.job/);
  assert.match(HEARTBEATS, /\[\[\.\.\.SCHEDULED_JOBS\]\]/);
});

test("lateness is judged from process start, not from the epoch", () => {
  const now = new Date("2026-08-17T12:00:00Z");

  // A worker up for ninety seconds has not failed to run its daily inference —
  // it has not reached it yet. Reporting that on every deploy is the fastest
  // way to teach somebody to ignore an operator.
  const justBooted = new Date(now.getTime() - 90_000);
  for (const job of SCHEDULED_JOBS) {
    assert.equal(isJobStalled(job, null, now, justBooted), false, `${job} flagged 90s after boot`);
  }

  // Once its own window has passed with no run, it is genuinely stalled.
  const longUp = new Date(now.getTime() - 40 * 3600_000);
  assert.equal(isJobStalled("operators", null, now, longUp), true);
  assert.equal(isJobStalled("forecast-cycle", null, longUp, longUp), false);

  // A completed run resets it regardless of how long the process has been up.
  assert.equal(
    isJobStalled("operators", new Date(now.getTime() - 60_000), now, longUp),
    false
  );
});

test("the sweep is the tightest tolerance, because its silence hides every other alarm", () => {
  const others = SCHEDULED_JOBS.filter((job) => job !== "operators");
  for (const job of others) {
    assert.ok(
      JOB_STALE_AFTER_SECONDS.operators < JOB_STALE_AFTER_SECONDS[job],
      `operators should be watched more tightly than ${job}`
    );
  }
  // Three intervals of a ten-minute job: late enough to survive one missed run
  // and a restart, tight enough to matter.
  assert.equal(JOB_STALE_AFTER_SECONDS.operators, 40 * 60);
});

test("the operator refuses to testify to its own liveness", () => {
  const operator = OPERATORS.slice(
    OPERATORS.indexOf("const scheduleStalled"),
    OPERATORS.indexOf("export const OPERATORS")
  );

  // `schedule-stalled` runs INSIDE the operator sweep. Checking whether the
  // sweep is running would pass in every case where it could conceivably be
  // needed: the sweep is running, therefore the sweep is running.
  assert.match(operator, /beat\.job !== "operators"/);

  // Excluded loudly rather than quietly. Whoever reads a finding should also
  // learn what this cannot tell them.
  assert.match(operator, /health\/jobs/);

  // Per job, so fixing one does not retract the others.
  assert.match(operator, /fingerprint: `schedule-stalled:\$\{beat\.job\}`/);

  assert.match(OPERATORS, /^\s*scheduleStalled,\s*$/m);
});

test("the check that comes from outside is a different route from the liveness probe", () => {
  // /health must stay cheap and unconditional: it is what a container
  // healthcheck reads, and a liveness probe that fails because a daily job is
  // late would restart a perfectly healthy container.
  assert.match(INDEX, /app\.get\("\/health", \(c\) => c\.json\(\{ status: "ok" \}\)\);/);

  // The new one is separate, unauthenticated (an uptime check that needs a
  // session is one nobody wires up), and always 200 — the body carries the
  // verdict so nothing that treats a non-2xx as "restart this" is given a
  // reason to.
  assert.match(INDEX, /app\.get\("\/health\/jobs"/);
  // Whitespace collapsed, because this pinned the expression as CONTIGUOUS
  // TEXT and went red when a fourth condition made it wrap. What matters is
  // what ok is computed from, not how it is laid out.
  const flat = INDEX.replace(/\s+/g, " ");
  assert.ok(flat.includes("ok: stalled.length === 0"), "ok must be derived from the stalled list");
  // And from whether the queue half could be read at all: "I could not
  // check" is not "nothing is wrong", and a monitor must not be told they
  // are the same. Before this, a Redis outage came back ok:true.
  assert.ok(
    flat.includes("!queuesUnreadable"),
    "ok must be false when the queue half could not be read"
  );
  assert.ok(
    !/\/health\/jobs[\s\S]{0,2000}c\.json\([^)]*\},\s*5\d\d\)/.test(INDEX),
    "the jobs endpoint must not return a non-2xx status"
  );
});

test("the unauthenticated endpoint carries no free text", () => {
  // It shipped returning the raw Error.message of whatever each background job
  // last threw, to any anonymous caller — and production was at that moment
  // handing out the platform's tenant-isolation mechanism by name. Flagged by a
  // security review of the same day's work.
  //
  // The set of strings reachable there is unbounded: six jobs talk to Postgres,
  // Redis, Google, Meta and arbitrary customer websites, and driver errors carry
  // host names, database and role names, SQL fragments and upstream URLs.
  // Truncating at 500 characters bounded the length and nothing else.
  const route = INDEX.slice(INDEX.indexOf('app.get("/health/jobs"'));
  const returned = route.slice(0, route.indexOf("readQueueHealth"));
  assert.ok(
    !/lastError: beat\.lastError/.test(returned),
    "the raw error message must not be returned to an unauthenticated caller"
  );
  assert.match(returned, /lastRunFailed: lastRunFailed\(beat\.lastErrorAt, beat\.lastFinishedAt\)/);

  // The message is not lost: `schedule-stalled` puts it in a finding detail,
  // which the operators deck shows behind a session.
  assert.match(OPERATORS, /beat\.lastError/);
});

test("the boolean means what its name says", () => {
  // `lastError` is deliberately never cleared by a later success, so
  // `lastError !== null` means "has EVER failed". Calling that lastRunFailed
  // would be a field whose name does not match its meaning — the exact class of
  // defect this session spent its time removing.
  assert.match(INDEX, /function lastRunFailed\(lastErrorAt: string \| null, lastFinishedAt: string \| null\)/);
  assert.match(INDEX, /return Date\.parse\(lastErrorAt\) > Date\.parse\(lastFinishedAt\);/);
});

test("these rows belong to no tenant, and every read says so", () => {
  // job_heartbeats has no organization_id and no RLS — the jobs run across every
  // business at once. `withAllTenants` demands a reason, which is what makes an
  // unscoped read a decision rather than a forgotten withTenant.
  // Asserted against the DDL rather than the whole file, which discusses the
  // absence at length — a test that greps the prose passes on the explanation
  // instead of the table.
  const ddl = MIGRATION.slice(
    MIGRATION.indexOf("create table if not exists job_heartbeats"),
    MIGRATION.indexOf("grant select, insert, update on job_heartbeats")
  );
  assert.ok(!/organization_id/.test(ddl), "a heartbeat has no tenant");
  assert.ok(!/enable row level security/i.test(MIGRATION));
  assert.match(HEARTBEATS, /const REASON = "job heartbeat: platform infrastructure, owned by no tenant"/);

  const unscopedReads = HEARTBEATS.match(/withAllTenants\(REASON/g) ?? [];
  assert.equal(unscopedReads.length, 3, "every heartbeat query must name its reason");

  // Nothing may delete a heartbeat: the rows ARE the evidence that something
  // ran, and one that can be removed can be removed by the fault that stopped
  // the job.
  assert.match(MIGRATION, /revoke delete on job_heartbeats from nexus_app/);
});
