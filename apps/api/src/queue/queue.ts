import { Queue } from "bullmq";
import { Redis } from "ioredis";
import type { InboundWebhookJob } from "@nexus/shared";
import { env } from "../config/env.js";

export const INBOUND_WEBHOOK_QUEUE = "whatsapp:inbound-webhook";

let connection: Redis | undefined;
export function getRedisConnection(): Redis {
  if (!connection) {
    connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });
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
