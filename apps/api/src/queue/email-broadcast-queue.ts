import { Queue } from "bullmq";
import type { EmailBroadcastSendJob } from "@nexus/shared";
import { getRedisConnection } from "./queue.js";

/**
 * One job per email of a campaign (26 Oct 2026). Its own queue, apart from the
 * WhatsApp one: a mailbox is paced in seconds per email, a WhatsApp number in
 * messages per second, and sharing a queue would hold one channel to the
 * other's speed.
 *
 * Four attempts with a long backoff: a mail server that is busy is usually busy
 * for minutes, not seconds.
 */
export const EMAIL_BROADCAST_QUEUE = "email-broadcast-send";

let emailQueue: Queue<EmailBroadcastSendJob> | undefined;
export function getEmailBroadcastQueue(): Queue<EmailBroadcastSendJob> {
  if (!emailQueue) {
    emailQueue = new Queue<EmailBroadcastSendJob>(EMAIL_BROADCAST_QUEUE, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 4,
        backoff: { type: "exponential", delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    });
  }
  return emailQueue;
}
