import { Queue } from "bullmq";
import { PF_LISTING_CALLS_READY } from "@nexus/shared";
import { getRedisConnection } from "./queue.js";

// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const PF_SYNC_QUEUE = "pf-sync";

/** Stable id so re-scheduling on every boot replaces rather than duplicates. */
const CYCLE_JOB_ID = "pf-sync-cycle";

/**
 * Every ten minutes (7 Nov 2026).
 *
 * The cycle is the floor: a unit's own job, queued half a minute after somebody
 * changes it, is what makes Property Finder follow the board quickly. The cycle
 * catches what that job could not — Redis down when the change was saved, a
 * permit that expired overnight, a failure worth retrying.
 */
const EVERY_TEN_MINUTES_MS = 10 * 60 * 1000;

/** Several quick edits (a title, then a photo, then the switch) make one run. */
const UNIT_DELAY_MS = 30_000;

let queue: Queue | undefined;
export function getPfSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue(PF_SYNC_QUEUE, {
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

export async function schedulePfSync(): Promise<void> {
  await getPfSyncQueue().add("cycle", {}, { jobId: CYCLE_JOB_ID, repeat: { every: EVERY_TEN_MINUTES_MS } });
}

type Deps = { queue?: { add: (...args: never[]) => Promise<unknown> } | Pick<Queue, "add">; ready?: boolean };

/**
 * One unit, half a minute after it changed. The job id is the unit's, so edits
 * inside that half minute join the waiting job; the id is freed when the job
 * ends, so a later edit gets a job of its own. Nothing is queued while the
 * listing calls are not built.
 */
export async function queuePfUnit(organizationId: string, unitId: string, deps: Deps = {}): Promise<void> {
  if (!(deps.ready ?? PF_LISTING_CALLS_READY)) return;
  const q = (deps.queue ?? getPfSyncQueue()) as Pick<Queue, "add">;
  await q.add(
    "unit",
    { organizationId, unitId },
    { jobId: `pf-unit-${unitId}`, delay: UNIT_DELAY_MS, removeOnComplete: true, removeOnFail: true }
  );
}

/** A cycle now — after an admin saves a key that checks out. */
export async function queuePfCycle(deps: Deps = {}): Promise<void> {
  if (!(deps.ready ?? PF_LISTING_CALLS_READY)) return;
  const q = (deps.queue ?? getPfSyncQueue()) as Pick<Queue, "add">;
  await q.add("cycle", {}, { removeOnComplete: true, removeOnFail: true });
}
