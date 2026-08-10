import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const TEMPLATE_SYNC_QUEUE = "template-sync";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "template-sync-cycle";

/**
 * Half-hourly.
 *
 * Meta reviews a template on its own schedule — usually minutes, sometimes
 * hours — and tells us nothing when it finishes. Without polling, an owner who
 * submits a template sees "awaiting review" until they happen to press the
 * button, which makes an approval that already happened look like a failure.
 *
 * Half an hour is chosen against what the call costs, not against how fast
 * approval could theoretically arrive: it is one paged read per business, and
 * the Broadcasts page has an explicit check button for anyone who does not want
 * to wait. Polling every minute would buy little and burn rate limit that the
 * message pipeline shares.
 */
const EVERY_THIRTY_MINUTES_MS = 30 * 60 * 1000;

let queue: Queue | undefined;
export function getTemplateSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue(TEMPLATE_SYNC_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // One retry. A cycle that fails is superseded by the next one in half
        // an hour, and templates do not change often enough to justify more.
        attempts: 2,
        backoff: { type: "exponential", delay: 20_000 },
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleTemplateSync(): Promise<void> {
  await getTemplateSyncQueue().add(
    "sync",
    {},
    { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_THIRTY_MINUTES_MS } }
  );
}
