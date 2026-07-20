import { Queue } from "bullmq";
import type { BroadcastSendJob } from "@nexus/shared";
import { getRedisConnection } from "./queue.js";

export const BROADCAST_SEND_QUEUE = "whatsapp-broadcast-send"; // BullMQ rejects ":" in queue names

let broadcastQueue: Queue<BroadcastSendJob> | undefined;
export function getBroadcastSendQueue(): Queue<BroadcastSendJob> {
  if (!broadcastQueue) {
    broadcastQueue = new Queue<BroadcastSendJob>(BROADCAST_SEND_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return broadcastQueue;
}
