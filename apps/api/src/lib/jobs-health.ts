import { listJobHeartbeats } from "@nexus/db";
import { isJobStalled, type ScheduledJob } from "@nexus/shared";
import { readQueueHealth } from "../queue/queue-health.js";

/**
 * Is any background job or queue broken right now? The same signal as the
 * /health/jobs route and the deck's health strip, reduced to what an owner's
 * phone alert needs: which job failed or stalled, which queue is failing.
 *
 * Built from the same parts as the route in index.ts rather than extracted
 * from it, because that route's text is pinned by its own tests (what it may
 * say to an anonymous caller, how it reports an unreadable queue). The one rule
 * the two must share — when "the last run failed" — is written the same way.
 */
function lastRunFailed(lastErrorAt: string | null, lastFinishedAt: string | null): boolean {
  if (!lastErrorAt) return false;
  if (!lastFinishedAt) return true;
  return Date.parse(lastErrorAt) > Date.parse(lastFinishedAt);
}

export async function computeJobsHealth(): Promise<{
  jobs: { job: string; lastRunFailed: boolean; stalled: boolean }[];
  queues: { queue: string; failing: boolean }[];
}> {
  const now = new Date();
  // This process's start, the floor for "has never run": just after a deploy it
  // errs toward silence rather than alerting about a job that has not had time.
  const bootedAt = new Date(Date.now() - process.uptime() * 1000);
  const beats = await listJobHeartbeats();
  const jobs = beats.map((beat) => ({
    job: beat.job,
    lastRunFailed: lastRunFailed(beat.lastErrorAt, beat.lastFinishedAt),
    stalled: isJobStalled(
      beat.job as ScheduledJob,
      beat.lastFinishedAt ? new Date(beat.lastFinishedAt) : null,
      now,
      bootedAt
    ),
  }));
  const queues = await readQueueHealth(Object.fromEntries(beats.map((beat) => [beat.job, beat.lastFinishedAt])));
  return { jobs, queues: queues.map((q) => ({ queue: q.queue, failing: q.failing })) };
}
