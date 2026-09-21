import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const EMAIL_SYNC_QUEUE = "email-sync";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "email-sync-cycle";

/**
 * Every fifteen minutes.
 *
 * The same cadence as the calendar sync, and for a compatible reason: the cost
 * of being wrong is a customer's email sitting unseen, not a live outage, so the
 * bound that matters is "how stale can the inbox get", and a quarter of an hour
 * keeps it shorter than a reasonable person waits before checking again. Faster
 * would hammer Gmail once per connected mailbox to learn nothing most cycles —
 * client mail does not arrive by the minute — and slower would let a genuine
 * enquiry age past the point where a same-day reply still feels prompt.
 *
 * A person who needs their mail RIGHT NOW still has the manual "sync now" the
 * inbox fires on open; this sweep is the floor under that, so nothing depends on
 * anybody remembering to look.
 */
const EVERY_FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

let queue: Queue | undefined;
export function getEmailSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue(EMAIL_SYNC_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // One retry. A cycle that fails is superseded by the next one in a
        // quarter of an hour, and each mailbox's own failure is recorded on its
        // connection row regardless of whether the cycle as a whole is retried.
        attempts: 2,
        backoff: { type: "exponential", delay: 15_000 },
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleEmailSync(): Promise<void> {
  await getEmailSyncQueue().add(
    "sync",
    {},
    { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_FIFTEEN_MINUTES_MS } }
  );
}
