import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const PROCEDURE_INFERENCE_QUEUE = "procedure-inference";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const REPEAT_JOB_ID = "procedure-inference-cycle";

/**
 * Daily, unlike the hourly quality rollup, and the difference is the point.
 *
 * The rollup recomputes numbers, so running it often costs correctness nothing
 * and keeps today's figures current. This calls a model per business per intent
 * and produces something a person has to READ. Hourly it would spend real money
 * re-deriving the same method from the same conversations, and — worse — it
 * would put a review queue in front of somebody that refills faster than they
 * can empty it.
 *
 * A procedure is how a business works. That does not change between breakfast
 * and lunch, and a writer that behaves as though it might is a writer nobody
 * will keep reading.
 */
const EVERY_DAY_MS = 24 * 60 * 60 * 1000;

let queue: Queue | undefined;
export function getProcedureQueue(): Queue {
  if (!queue) {
    queue = new Queue(PROCEDURE_INFERENCE_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // Two attempts, well spaced. The likely failure is a model rate limit,
        // which an immediate retry only repeats.
        attempts: 2,
        backoff: { type: "exponential", delay: 120_000 },
        removeOnComplete: 14,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleProcedureInference(): Promise<void> {
  await getProcedureQueue().add(
    "infer",
    {},
    { jobId: REPEAT_JOB_ID, repeat: { every: EVERY_DAY_MS } }
  );
}
