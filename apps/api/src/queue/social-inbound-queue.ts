import { Queue } from "bullmq";
import type { SocialInboundJob } from "@nexus/shared";
import { getRedisConnection } from "./queue.js";

// A separate queue from the WhatsApp inbound one, deliberately: a Messenger/
// Instagram delivery is a different payload shape handled by a different
// processor, and keeping it off the WhatsApp queue means a flood or a failure on
// one channel cannot back up or retry the other — the reply path that matters
// most stays isolated. BullMQ rejects ":" in queue names, so hyphens only.
export const SOCIAL_INBOUND_QUEUE = "social-inbound-webhook";

let socialQueue: Queue<SocialInboundJob> | undefined;
export function getSocialInboundQueue(): Queue<SocialInboundJob> {
  if (!socialQueue) {
    socialQueue = new Queue<SocialInboundJob>(SOCIAL_INBOUND_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return socialQueue;
}
