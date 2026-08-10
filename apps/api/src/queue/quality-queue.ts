import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const QUALITY_ROLLUP_QUEUE = "quality-rollup";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "quality-rollup-cycle";

/**
 * Hourly, not daily.
 *
 * The natural instinct is to roll up once a night, but then today's figures do
 * not exist until tomorrow — and the day an owner most wants to look at is the
 * one happening now. Hourly keeps the current day current, and because each run
 * recomputes rather than accumulates, running it often costs correctness
 * nothing.
 */
const EVERY_HOUR_MS = 60 * 60 * 1000;

let queue: Queue | undefined;
export function getQualityQueue(): Queue {
  if (!queue) {
    queue = new Queue(QUALITY_ROLLUP_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 24,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleQualityRollup(): Promise<void> {
  await getQualityQueue().add("rollup", {}, { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_HOUR_MS } });
}
