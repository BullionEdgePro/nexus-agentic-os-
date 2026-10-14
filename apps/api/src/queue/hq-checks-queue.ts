import { Queue } from "bullmq";
import { getRedisConnection } from "./queue.js";

/**
 * Business HQ's website checks (spec 2026-10-14-business-hq-design.md §7):
 * every business at 06:00 Dubai time, and one business on "Check now".
 */
// BullMQ rejects queue names containing ":" — hyphens only (see queue.ts).
export const HQ_CHECKS_QUEUE = "hq-checks";

const REPEAT_JOB_ID = "hq-checks-daily";

export interface HqChecksJob {
  /** One business ("Check now"); absent for the daily run of all of them. */
  organizationId?: string;
}

let queue: Queue<HqChecksJob> | undefined;
export function getHqChecksQueue(): Queue<HqChecksJob> {
  if (!queue) {
    queue = new Queue<HqChecksJob>(HQ_CHECKS_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        // One retry: a failed morning run is superseded by tomorrow's, and each
        // check already records its own "could not check".
        attempts: 2,
        backoff: { type: "exponential", delay: 60_000 },
        removeOnComplete: 20,
        removeOnFail: 50,
      },
    });
  }
  return queue;
}

export async function scheduleHqChecks(): Promise<void> {
  await getHqChecksQueue().add("daily", {}, { jobId: REPEAT_JOB_ID, repeat: { pattern: "0 6 * * *", tz: "Asia/Dubai" } });
}

/**
 * "Check now" for one business, at most once per 5 minutes: the checks call
 * Google PageSpeed and RDAP, and hammering either gets the server rate-limited
 * for everyone.
 */
export async function enqueueHqCheckNow(organizationId: string): Promise<"queued" | "too-soon"> {
  const first = await getRedisConnection().set(`hq:checknow:${organizationId}`, "1", "EX", 300, "NX");
  if (first !== "OK") return "too-soon";
  await getHqChecksQueue().add("now", { organizationId });
  return "queued";
}
