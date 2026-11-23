import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

/**
 * The Bayut sync's queue (23 Nov 2026): a cycle every ten minutes, and each
 * unit's own run half a minute after it changed (a switch, the listing, a
 * photo, the Bayut location, the agent's link). The cycle is the floor: it
 * catches what a unit's job could not — Redis down when the change was saved,
 * a permit that expired overnight, Bayut's own answers. A token that checks
 * out queues a cycle at once.
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §10
 */

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const BAYUT_SYNC_QUEUE = "bayut-sync";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const CYCLE_JOB_ID = "bayut-sync-cycle";

const EVERY_TEN_MINUTES_MS = 10 * 60 * 1000;

/** Several quick edits (a title, then a photo, then the switch) make one run. */
const UNIT_DELAY_MS = 30_000;

let queue: Queue | undefined;
export function getBayutSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue(BAYUT_SYNC_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // One retry; the next cycle supersedes a cycle that failed outright.
        attempts: 2,
        backoff: { type: "exponential", delay: 20_000 },
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleBayutSync(): Promise<void> {
  await getBayutSyncQueue().add("cycle", {}, { jobId: CYCLE_JOB_ID, repeat: { every: EVERY_TEN_MINUTES_MS } });
}

type Deps = { queue?: { add: (...args: never[]) => Promise<unknown> } | Pick<Queue, "add"> };

/**
 * One unit, half a minute after it changed. The job id is the unit's, so edits
 * inside that half minute join the waiting job; the id is freed when the job
 * ends, so a later edit gets a job of its own. Callers never let a failure to
 * queue fail the request (the cycle follows anyway).
 */
export async function queueBayutUnit(organizationId: string, unitId: string, deps: Deps = {}): Promise<void> {
  const q = (deps.queue ?? getBayutSyncQueue()) as Pick<Queue, "add">;
  await q.add(
    "unit",
    { organizationId, unitId },
    { jobId: `bayut-unit-${unitId}`, delay: UNIT_DELAY_MS, removeOnComplete: true, removeOnFail: true }
  );
}

/** A cycle now — after an admin saves a token that checks out. */
export async function queueBayutCycle(deps: Deps = {}): Promise<void> {
  const q = (deps.queue ?? getBayutSyncQueue()) as Pick<Queue, "add">;
  await q.add("cycle", {}, { removeOnComplete: true, removeOnFail: true });
}
