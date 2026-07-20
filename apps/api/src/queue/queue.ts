import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { InboundWebhookJob } from "@nexus/shared";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

// BullMQ rejects queue names containing ":" (it uses colons internally for
// Redis key namespacing) — hyphens only.
export const INBOUND_WEBHOOK_QUEUE = "whatsapp-inbound-webhook";

let connection: Redis | undefined;
export function getRedisConnection(): Redis {
  if (!connection) {
    // maxRetriesPerRequest: null is required by BullMQ — without it, a
    // sustained Redis outage eventually throws MaxRetriesPerRequestError,
    // an uncaught exception that would kill the whole process.
    connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
    connection.on("error", (err) => logger.warn({ err }, "Redis connection error (will keep retrying)"));
  }
  return connection;
}

let inboundQueue: Queue<InboundWebhookJob> | undefined;
export function getInboundWebhookQueue(): Queue<InboundWebhookJob> {
  if (!inboundQueue) {
    inboundQueue = new Queue<InboundWebhookJob>(INBOUND_WEBHOOK_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return inboundQueue;
}
