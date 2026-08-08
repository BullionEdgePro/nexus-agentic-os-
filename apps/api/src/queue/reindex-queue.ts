import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const KNOWLEDGE_REINDEX_QUEUE = "knowledge-reindex";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "knowledge-reindex-cycle";

const EVERY_SIX_HOURS_MS = 6 * 60 * 60 * 1000;

let queue: Queue | undefined;
export function getReindexQueue(): Queue {
  if (!queue) {
    queue = new Queue(KNOWLEDGE_REINDEX_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // One retry only. A refresh cycle that fails is picked up by the next
        // cycle anyway, so aggressive retries would just burn embedding quota
        // re-fetching pages that are about to be re-fetched regardless.
        attempts: 2,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 50,
        removeOnFail: 100,
      },
    });
  }
  return queue;
}

/**
 * Schedule the recurring refresh.
 *
 * Idempotent: BullMQ keys repeatable jobs by id + pattern, so calling this on
 * every worker boot updates the existing schedule instead of stacking a new
 * one per restart — which would otherwise multiply embedding spend by the
 * number of deploys.
 */
export async function scheduleKnowledgeReindex(): Promise<void> {
  await getReindexQueue().add(
    "reindex",
    {},
    { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_SIX_HOURS_MS } }
  );
}
