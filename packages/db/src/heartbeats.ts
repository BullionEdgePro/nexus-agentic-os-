import { getPool, withAllTenants } from "./client.js";
import { SCHEDULED_JOBS, type ScheduledJob } from "@nexus/shared";

/**
 * Did the scheduled work actually run? (migration 050)
 *
 * Six jobs are scheduled at worker boot and all six are scheduled best-effort,
 * so any of them can fail to schedule or stop repeating while the platform goes
 * on looking healthy. The worst is the operator sweep: if it stops, all fifteen
 * operators go quiet and the deck reports "0 standing findings", which is
 * indistinguishable from a platform with nothing wrong.
 *
 * Every read and write here is `withAllTenants`. These rows belong to no
 * business — the jobs run across all of them at once — and saying so out loud is
 * the point of that wrapper: an unscoped query has to name a reason, so it is a
 * decision rather than a forgotten `withTenant`.
 */

const REASON = "job heartbeat: platform infrastructure, owned by no tenant";

/** One job's last known state. Null timestamps mean it has never run. */
export interface JobHeartbeat {
  job: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  runs: number;
  failures: number;
}

/**
 * Runs `work`, recording that it started and how it ended.
 *
 * Wraps rather than being called around, so a job cannot record a start and
 * forget the finish — which is the state this table is meant to be able to
 * DETECT (a hanging job) and would be a terrible way to produce by accident.
 *
 * The bookkeeping is best-effort in both directions. A heartbeat write that
 * fails must not take down the work it is watching, and work that throws must
 * still rethrow after being recorded: the caller's own error handling, its
 * retries and its logging all predate this and stay in charge.
 */
export async function withJobHeartbeat<T>(job: ScheduledJob, work: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  await markStarted(job).catch(() => undefined);

  try {
    const result = await work();
    await markFinished(job, Date.now() - startedAt, null).catch(() => undefined);
    return result;
  } catch (err) {
    await markFinished(job, Date.now() - startedAt, describe(err)).catch(() => undefined);
    throw err;
  }
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Truncated because this is read on a status page, not in a debugger, and a
  // stack trace pasted into a table cell makes the row unreadable. The log
  // still has the whole thing.
  return message.slice(0, 500);
}

async function markStarted(job: ScheduledJob): Promise<void> {
  await withAllTenants(REASON, async () => {
    await getPool().query(
      `insert into job_heartbeats (job, last_started_at, runs)
       values ($1, now(), 1)
       on conflict (job) do update
         set last_started_at = now(),
             runs = job_heartbeats.runs + 1`,
      [job]
    );
  });
}

async function markFinished(
  job: ScheduledJob,
  durationMs: number,
  error: string | null
): Promise<void> {
  await withAllTenants(REASON, async () => {
    await getPool().query(
      `update job_heartbeats
          set last_finished_at = case when $3::text is null then now() else last_finished_at end,
              last_duration_ms = $2,
              -- The error is kept rather than cleared by a later success, so a
              -- job failing every other run cannot look green half the time.
              last_error = coalesce($3, last_error),
              last_error_at = case when $3::text is null then last_error_at else now() end,
              failures = failures + case when $3::text is null then 0 else 1 end
        where job = $1`,
      [job, durationMs, error]
    );
  });
}

/**
 * Every job's heartbeat, including the ones that have never run.
 *
 * A job MISSING from `job_heartbeats` is the most important case this returns,
 * and the one a plain `select` would quietly omit: a scheduler that failed to
 * register writes no row at all, so reading only what exists would report five
 * healthy jobs and no sign of the sixth. The known job list is the left side of
 * the join for that reason.
 */
export async function listJobHeartbeats(): Promise<JobHeartbeat[]> {
  return withAllTenants(REASON, async () => {
    const { rows } = await getPool().query<{
      job: string;
      last_started_at: string | null;
      last_finished_at: string | null;
      last_duration_ms: number | null;
      last_error: string | null;
      last_error_at: string | null;
      runs: string | null;
      failures: string | null;
    }>(
      `select j.job,
              h.last_started_at,
              h.last_finished_at,
              h.last_duration_ms,
              h.last_error,
              h.last_error_at,
              h.runs,
              h.failures
         from unnest($1::text[]) as j(job)
         left join job_heartbeats h on h.job = j.job
        order by j.job`,
      [[...SCHEDULED_JOBS]]
    );

    return rows.map((row) => ({
      job: row.job,
      lastStartedAt: row.last_started_at,
      lastFinishedAt: row.last_finished_at,
      lastDurationMs: row.last_duration_ms,
      lastError: row.last_error,
      lastErrorAt: row.last_error_at,
      runs: Number(row.runs ?? 0),
      failures: Number(row.failures ?? 0),
    }));
  });
}
