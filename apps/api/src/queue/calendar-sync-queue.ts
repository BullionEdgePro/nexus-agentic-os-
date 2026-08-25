import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const CALENDAR_SYNC_QUEUE = "calendar-sync";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "calendar-sync-cycle";

/**
 * Every fifteen minutes.
 *
 * Chosen against what being WRONG costs, which is the only number that matters
 * here. This decides whether the agent tells a customer that a person will
 * follow up. Sync hourly and somebody who went into a meeting at ten past is
 * offered to customers for the next fifty minutes; sync every minute and this
 * platform hammers Google on behalf of five businesses to learn nothing, most
 * of the time, about diaries that change a few times a day.
 *
 * Fifteen minutes bounds the error at a quarter of an hour, which is shorter
 * than most meetings and shorter than the ten-minute operator sweep's own
 * blind spot — so the calendar is never the reason a promise is stale.
 */
const EVERY_FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

let queue: Queue | undefined;
export function getCalendarSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue(CALENDAR_SYNC_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // One retry. A cycle that fails is superseded by the next one in a
        // quarter of an hour, and a failed sync leaves the previous answer
        // standing rather than emptying anybody's diary.
        attempts: 2,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleCalendarSync(): Promise<void> {
  await getCalendarSyncQueue().add(
    "sync",
    {},
    { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_FIFTEEN_MINUTES_MS } }
  );
}
