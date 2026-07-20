import { Worker } from "bullmq";
import type { InboundWebhookJob, BroadcastSendJob } from "@nexus/shared";
import { INBOUND_WEBHOOK_QUEUE, getRedisConnection } from "./queue/queue.js";
import { processInboundWebhookJob } from "./queue/processor.js";
import { BROADCAST_SEND_QUEUE } from "./queue/broadcast-queue.js";
import { processBroadcastSendJob } from "./queue/broadcast-processor.js";
import { logger } from "./lib/logger.js";

const inboundWorker = new Worker<InboundWebhookJob>(INBOUND_WEBHOOK_QUEUE, processInboundWebhookJob, {
  connection: getRedisConnection(),
  concurrency: 10,
});

// Meta enforces per-tier messaging throughput limits; 20/sec is a
// conservative default for template sends — tune to your business's
// approved messaging tier.
const broadcastWorker = new Worker<BroadcastSendJob>(BROADCAST_SEND_QUEUE, processBroadcastSendJob, {
  connection: getRedisConnection(),
  concurrency: 5,
  limiter: { max: 20, duration: 1000 },
});

inboundWorker.on("completed", (job) => logger.debug({ jobId: job.id }, "Processed inbound webhook job"));
inboundWorker.on("failed", (job, err) =>
  logger.error({ jobId: job?.id, err }, "Failed to process inbound webhook job")
);

broadcastWorker.on("completed", (job) => logger.debug({ jobId: job.id }, "Processed broadcast send job"));
broadcastWorker.on("failed", (job, err) =>
  logger.error({ jobId: job?.id, err }, "Failed to process broadcast send job")
);

logger.info("Nexus background workers started (inbound webhook + broadcast send)");

async function shutdown() {
  logger.info("Shutting down workers...");
  await Promise.all([inboundWorker.close(), broadcastWorker.close()]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
