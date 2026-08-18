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
