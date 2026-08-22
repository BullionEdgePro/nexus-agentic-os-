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
 * The knowledge re-index's own contract, beside the schedule that drives it.
 *
 * These two numbers used to live only in reindex-processor.ts, where nothing
 * else could see them -- so any check on whether the refresh was KEEPING UP had
 * to hardcode a threshold and hope it still matched. Here they are the single
 * definition, and the bound below is derived rather than guessed.
 */
export const KNOWLEDGE_STALE_AFTER_HOURS = 24;
export const KNOWLEDGE_SOURCES_PER_RUN = 20;

/**
 * How often the re-index actually runs. THE definition -- reindex-queue.ts
 * imports this to register the repeat, so the schedule and anything judging it
 * cannot disagree.
 *
 * Written out rather than inferred from JOB_STALE_AFTER_SECONDS. That tolerance
 * happens to be three intervals for this job, and dividing by three to recover
 * the interval would be reading a coincidence as a contract -- the tolerances
 * above are explicitly "roughly three intervals for the frequent jobs and a
 * generous margin for the daily ones", so the ratio is not one for every job
 * and is not promised for any of them.
 */
export const KNOWLEDGE_REINDEX_INTERVAL_HOURS = 6;

/**
 * The oldest a source should ever get, if the sweep is keeping up.
 *
 * A source becomes ELIGIBLE at KNOWLEDGE_STALE_AFTER_HOURS and can then wait up
 * to one whole interval for the next run to pick it up. So the designed worst
 * case is threshold + interval -- 30 hours today -- and anything at or under
 * that is the system working, not a fault.
 *
 * Measured on production 2026-08-22: the oldest source was 28.5 hours, which is
 * inside this bound. An alarm set below it would have fired on a healthy
 * platform, which is how an alarm gets ignored.
 */
export function knowledgeRefreshBoundHours(): number {
  return KNOWLEDGE_STALE_AFTER_HOURS + KNOWLEDGE_REINDEX_INTERVAL_HOURS;
}

/**
 * How many sources the schedule can refresh in a day.
 *
 * The bound above only holds while the queue can drain. 20 sources every six
 * hours is 80 a day; past that, the oldest sources age without limit and every
 * reply is built from a progressively older copy of the page, with a citation
 * attached. There are 65 sources today, so there is headroom -- but one more
 * business with a forty-page site removes it, and nothing about that arrival
 * would announce itself.
 */
export function knowledgeRefreshCapacityPerDay(): number {
  return KNOWLEDGE_SOURCES_PER_RUN * (24 / KNOWLEDGE_REINDEX_INTERVAL_HOURS);
}

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
