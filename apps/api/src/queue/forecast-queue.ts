import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const FORECAST_QUEUE = "forecast-cycle";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "forecast-cycle";

/**
 * Daily, and unlike the other daily job the interval is part of the measurement
 * rather than a cost decision.
 *
 * Procedure inference is daily because it calls a model and produces something a
 * person must read. This calls no model and costs essentially nothing, so the
 * obvious move would be hourly. It would also be wrong.
 *
 * A forecast is a claim with a timestamp on it. Re-made every hour, the
 * horizon-1 row for tomorrow gets overwritten twenty-four times, and the version
 * that finally stands is whichever ran last — made from the most information,
 * closest to the event. The stored `made_at` would say "a day ahead" while the
 * claim was really made at 23:00. Every published accuracy figure would improve,
 * for no reason connected to the method being any good.
 *
 * Once a day, the interval between saying it and finding out is what it claims
 * to be.
 */
const EVERY_DAY_MS = 24 * 60 * 60 * 1000;

let queue: Queue | undefined;
export function getForecastQueue(): Queue {
  if (!queue) {
    queue = new Queue(FORECAST_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // The likely failure is the database being briefly unreachable mid
        // deploy. One well-spaced retry covers that; more would just repeat a
        // real error into the log.
        attempts: 2,
        backoff: { type: "exponential", delay: 120_000 },
        removeOnComplete: 14,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleForecastCycle(): Promise<void> {
  await getForecastQueue().add(
    "forecast",
    {},
    { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_DAY_MS } }
  );
}
