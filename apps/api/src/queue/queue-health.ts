import { Queue } from "bullmq";
import { getRedisConnection, INBOUND_WEBHOOK_QUEUE } from "./queue.js";
import { BROADCAST_SEND_QUEUE } from "./broadcast-queue.js";
import { FORECAST_QUEUE } from "./forecast-queue.js";
import { OPERATORS_QUEUE } from "./operators-queue.js";
import { PROCEDURE_INFERENCE_QUEUE } from "./procedures-queue.js";
import { QUALITY_ROLLUP_QUEUE } from "./quality-queue.js";
import { KNOWLEDGE_REINDEX_QUEUE } from "./reindex-queue.js";
import { TEMPLATE_SYNC_QUEUE } from "./template-sync-queue.js";

/**
 * What is stuck or lost in the queues — the half of the background system that
 * `job_heartbeats` cannot see.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Migration 050 answers "did the scheduled work run?" by having each job write
 * down that it did. That is a record of jobs which STARTED. It says nothing
 * about work sitting unprocessed, and nothing about work that failed every
 * retry and was set aside.
 *
 * The gap was not hypothetical. `bull:knowledge-reindex:failed` held twenty
 * failed jobs on 2026-08-18, and BullMQ had been recording every one of them
 * for as long as the re-index had been broken — in Redis, where nothing looked.
 * The heartbeat found that outage the same morning, and the failed set had known
 * about it the whole time.
 *
 * THE QUEUE THAT MATTERS MOST IS THE INBOUND ONE, and it is the one the
 * operators cannot cover. `customer-waiting` catches a customer who got no reply
 * — but it sweeps CONVERSATIONS, and `recordInboundMessage` is the first thing
 * the job does. A job that fails before that leaves no conversation, no contact
 * and no message: a customer messaged this business and there is nothing
 * anywhere to sweep. Five attempts with exponential backoff make it unlikely and
 * not impossible, and "unlikely and invisible" is the combination this platform
 * keeps getting caught by.
 *
 * Read from OUTSIDE rather than by an operator, deliberately. Operators are SQL
 * over Postgres and calling no model is what makes them affordable every ten
 * minutes; giving the operator framework a Redis dependency to answer one
 * question would be a larger change than the question is worth. `/health/jobs`
 * is already the place that answers "is the background system working", from a
 * process that is not the one being asked about.
 */

/** Every queue this platform runs, so a new one cannot be silently unwatched. */
const QUEUES = [
  INBOUND_WEBHOOK_QUEUE,
  BROADCAST_SEND_QUEUE,
  OPERATORS_QUEUE,
  QUALITY_ROLLUP_QUEUE,
  TEMPLATE_SYNC_QUEUE,
  KNOWLEDGE_REINDEX_QUEUE,
  PROCEDURE_INFERENCE_QUEUE,
  FORECAST_QUEUE,
] as const;

/**
 * How recent a failure has to be to mean something is wrong NOW.
 *
 * A count on its own cannot answer that. BullMQ keeps failed jobs until
 * retention trims them, so `failed: 20` describes both an outage happening this
 * minute and one that was fixed hours ago — and a health field that stays red
 * after the fix is one people learn to ignore. The newest failure's timestamp is
 * what separates them.
 */
const FAILING_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Work waiting with nothing processing it.
 *
 * Waiting is normal for a moment: a job is enqueued and picked up milliseconds
 * later. What is not normal is depth with no active worker, which is what a dead
 * or disconnected worker looks like from the outside.
 */
const BACKLOG_THRESHOLD = 20;

export interface QueueHealth {
  queue: string;
  waiting: number;
  active: number;
  failed: number;
  delayed: number;
  /** Milliseconds since the most recent failure, or null if there is none. */
  lastFailureAgeMs: number | null;
  /** A failure inside the window — something is going wrong now, not once. */
  failing: boolean;
  /** Depth with nothing working it off. */
  backedUp: boolean;
}

export async function readQueueHealth(): Promise<QueueHealth[]> {
  const connection = getRedisConnection();
  const now = Date.now();

  return Promise.all(
    QUEUES.map(async (name) => {
      // A short-lived handle rather than the module-level queue objects: this
      // runs in the API process, which does not own most of these queues and
      // must not start workers for them by touching their modules' singletons.
      const queue = new Queue(name, { connection });
      try {
        const counts = await queue.getJobCounts("wait", "active", "failed", "delayed");
        const waiting = counts.wait ?? 0;
        const active = counts.active ?? 0;
        const failed = counts.failed ?? 0;

        // The newest member of the failed sorted set, scored by timestamp.
        // Asking BullMQ for the job itself would fetch its whole payload —
        // including, on the inbound queue, a customer's message.
        const newest = failed > 0
          ? await connection.zrange(`bull:${name}:failed`, -1, -1, "WITHSCORES")
          : [];
        const lastFailureAt = newest.length === 2 ? Number(newest[1]) : null;

        return {
          queue: name,
          waiting,
          active,
          failed,
          delayed: counts.delayed ?? 0,
          lastFailureAgeMs: lastFailureAt === null ? null : now - lastFailureAt,
          failing: lastFailureAt !== null && now - lastFailureAt < FAILING_WINDOW_MS,
          // Both conditions, not either. A deep queue with workers on it is a
          // busy platform; a deep queue with none is a stopped one.
          backedUp: waiting >= BACKLOG_THRESHOLD && active === 0,
        };
      } finally {
        // The shared connection is NOT closed — it belongs to the process and
        // BullMQ would take the API's other queues down with it.
        await queue.close().catch(() => undefined);
      }
    })
  );
}
