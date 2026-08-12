import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const OPERATORS_QUEUE = "operators";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "operators-cycle";

/**
 * Every ten minutes.
 *
 * The pacing is set by the operator with the shortest useful reaction time —
 * `customer-waiting`, which reports somebody who has been ignored for two
 * hours. Checking that hourly would mean a customer could be waiting nearly
 * three hours before anyone was told, which defeats the point of noticing at
 * all.
 *
 * Ten minutes is affordable because a pass is a handful of indexed SQL queries
 * per business and calls no model. Were an operator ever added that did use
 * inference, this interval would be the first thing to revisit — five businesses
 * × six passes an hour × a model call is a bill, and that is exactly the
 * scaling §2.3 warned about.
 *
 * Re-running is harmless by construction: each pass recomputes the full picture
 * and reconciles, so running it often costs correctness nothing.
 */
const EVERY_TEN_MINUTES_MS = 10 * 60 * 1000;

let queue: Queue | undefined;
export function getOperatorsQueue(): Queue {
  if (!queue) {
    queue = new Queue(OPERATORS_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // Two attempts, not more. A pass that fails twice will be tried again
        // in ten minutes anyway; piling up retries of a broken query just fills
        // the log with the same error.
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 24,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleOperators(): Promise<void> {
  await getOperatorsQueue().add(
    "sweep",
    {},
    { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_TEN_MINUTES_MS } }
  );
}
