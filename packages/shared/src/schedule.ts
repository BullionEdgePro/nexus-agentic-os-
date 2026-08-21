/**
 * What is supposed to run, and how often — the contract in one place.
 *
 * These intervals already exist, once each, inside the six `*-queue.ts` modules
 * that register the repeat. This is not a second copy of the schedule: it is the
 * EXPECTATION used to judge a heartbeat, and it is passed to Postgres as a
 * parameter rather than written into any SQL, so the operator and the status
 * endpoint agree by construction instead of by coincidence.
 *
 * The tolerance is the interesting number. It is not "how long until this is
 * late" but "how long until lateness means something is broken", and it has to
 * absorb an ordinary deploy: the worker restarts, its repeat keys re-register,
 * and the first run of a daily job lands up to a day later. A tolerance tighter
 * than that produces a finding every time somebody ships, which is the fastest
 * way to teach a person to ignore an operator.
 */
export const SCHEDULED_JOBS = [
  "operators",
  "quality-rollup",
  "template-sync",
  "knowledge-reindex",
  "procedure-inference",
  "forecast-cycle",
] as const;

export type ScheduledJob = (typeof SCHEDULED_JOBS)[number];

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Seconds after which a job that has not finished is considered stalled.
 *
 * Roughly three intervals for the frequent jobs and a generous margin for the
 * daily ones. `operators` is the tightest at 40 minutes because it is the alarm
 * system: everything else this platform reports depends on it running, and its
 * silence is the silence that hides all the others.
 */
export const JOB_STALE_AFTER_SECONDS: Record<ScheduledJob, number> = {
  operators: 40 * MINUTE,
  "quality-rollup": 3 * HOUR,
  "template-sync": 2 * HOUR,
  "knowledge-reindex": 18 * HOUR,
  "procedure-inference": 30 * HOUR,
  "forecast-cycle": 30 * HOUR,
};

/**
 * Whether this job has been silent long enough to mean something.
 *
 * A job that has NEVER run is stalled once its own window has passed since the
 * caller's reference point — not immediately. A worker that came up ninety
 * seconds ago has not failed to run its daily inference; it has not got there
 * yet, and reporting that as a fault on every deploy would make the whole
 * signal worthless.
 */
/**
 * Whether this job has thrown RECENTLY, whatever it did afterwards.
 *
 * `isJobStalled` asks whether a job has stopped completing, and that catches a
 * job which fails EVERY time -- its last_finished_at freezes and the window
 * runs out. It cannot catch a job that fails INTERMITTENTLY: every success
 * moves last_finished_at forward again, so the window never runs out and the
 * failures are invisible.
 *
 * knowledge-reindex is exactly that shape. Measured on 2026-08-21: sixteen
 * runs, TWO failures, and nothing on the platform ever said a word about
 * either. Both were the tenant-scope assert firing inside the ingest path, and
 * they were found by a person reading job_heartbeats by hand three days later.
 *
 * TWO WINDOWS, NOT ONE. A single window would retract the finding the moment
 * the next run succeeded, which for an intermittent fault is precisely when it
 * is still true -- the whole point is that it succeeds in between. Two gives a
 * failure long enough on screen to be read, and lets a genuinely fixed job
 * clear itself without anybody touching a row.
 *
 * `last_error` is deliberately sticky in the heartbeat -- it survives later
 * successes so a job failing every other run cannot look green half the time --
 * so the presence of an error says nothing about WHEN. This compares the
 * timestamp instead, which is the only part that carries recency.
 */
export function hasJobFailedRecently(
  job: ScheduledJob,
  lastErrorAt: Date | null,
  now: Date
): boolean {
  if (!lastErrorAt) return false;
  const window = JOB_STALE_AFTER_SECONDS[job] * 1000 * 2;
  return now.getTime() - lastErrorAt.getTime() <= window;
}

export function isJobStalled(
  job: ScheduledJob,
  lastFinishedAt: Date | null,
  now: Date,
  processStartedAt: Date
): boolean {
  const window = JOB_STALE_AFTER_SECONDS[job] * 1000;
  const since = (lastFinishedAt ?? processStartedAt).getTime();
  return now.getTime() - since > window;
}
