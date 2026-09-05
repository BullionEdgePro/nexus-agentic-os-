import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// Hyphens only — BullMQ rejects ":" in queue names (see queue.ts).
export const SCHEDULED_MESSAGES_QUEUE = "scheduled-messages";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "scheduled-messages-sweep";

/**
 * Every minute.
 *
 * The unit a person schedules in is minutes ("send at 9:00"), so the sweep has
 * to be at least that fine or a 9:00 message goes at 9:14. A minute is cheap —
 * the sweep is one indexed query that usually returns nothing — and it bounds
 * lateness to under sixty seconds, which is as precise as a "send tomorrow
 * morning" reply ever needs to be.
 */
const EVERY_MINUTE_MS = 60 * 1000;

let queue: Queue | undefined;
export function getScheduledMessagesQueue(): Queue {
  if (!queue) {
    queue = new Queue(SCHEDULED_MESSAGES_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // No retry on the SWEEP itself: a failed sweep is superseded by the next
        // one a minute later, and each claims fresh due rows, so retrying the
        // sweep would only risk re-touching rows the next run will pick up anyway.
        attempts: 1,
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleScheduledMessageSweep(): Promise<void> {
  await getScheduledMessagesQueue().add(
    "sweep",
    {},
    { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_MINUTE_MS } }
  );
}
