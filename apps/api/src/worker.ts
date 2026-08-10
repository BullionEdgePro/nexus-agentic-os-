import { Worker } from "bullmq";
import type { InboundWebhookJob, BroadcastSendJob } from "@nexus/shared";
import { INBOUND_WEBHOOK_QUEUE, getRedisConnection } from "./queue/queue.js";
import { processInboundWebhookJob } from "./queue/processor.js";
import { BROADCAST_SEND_QUEUE } from "./queue/broadcast-queue.js";
import { processBroadcastSendJob } from "./queue/broadcast-processor.js";
import { KNOWLEDGE_REINDEX_QUEUE, scheduleKnowledgeReindex } from "./queue/reindex-queue.js";
import { processKnowledgeReindexJob } from "./queue/reindex-processor.js";
import { TEMPLATE_SYNC_QUEUE, scheduleTemplateSync } from "./queue/template-sync-queue.js";
import { processTemplateSyncJob } from "./queue/template-sync-processor.js";
import { preflightModels } from "@nexus/agents";
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

// Concurrency 1: a refresh cycle is embedding-bound, and running cycles in
// parallel would multiply spend against a rate-limited quota for no gain.
const reindexWorker = new Worker(KNOWLEDGE_REINDEX_QUEUE, processKnowledgeReindexJob, {
  connection: getRedisConnection(),
  concurrency: 1,
});

const templateSyncWorker = new Worker(TEMPLATE_SYNC_QUEUE, processTemplateSyncJob, {
  connection: getRedisConnection(),
  concurrency: 1,
});
templateSyncWorker.on("failed", (job, err) =>
  logger.error({ jobId: job?.id, err }, "Template sync job failed")
);

reindexWorker.on("failed", (job, err) =>
  logger.error({ jobId: job?.id, err }, "Knowledge re-index job failed")
);

inboundWorker.on("completed", (job) => logger.debug({ jobId: job.id }, "Processed inbound webhook job"));
inboundWorker.on("failed", (job, err) =>
  logger.error({ jobId: job?.id, err }, "Failed to process inbound webhook job")
);

broadcastWorker.on("completed", (job) => logger.debug({ jobId: job.id }, "Processed broadcast send job"));
broadcastWorker.on("failed", (job, err) =>
  logger.error({ jobId: job?.id, err }, "Failed to process broadcast send job")
);

logger.info("Nexus background workers started (inbound webhook + broadcast send + knowledge re-index)");

// Idempotent — replaces the existing schedule rather than stacking one per
// deploy. Best-effort: a scheduling failure must not stop message processing.
scheduleKnowledgeReindex()
  .then(() => logger.info("Knowledge re-index scheduled (every 6h)"))
  .catch((err) => logger.warn({ err }, "Could not schedule knowledge re-index"));

// Meta never tells us when a template's review finishes, so the only way an
// approval reaches the product is by asking. Without this, a template approved
// minutes after submission still reads as "awaiting review" until somebody
// happens to press the check button.
scheduleTemplateSync()
  .then(() => logger.info("Template sync scheduled (every 30m)"))
  .catch((err) => logger.warn({ err }, "Could not schedule template sync"));

// Verify every configured model is actually callable. A model that 404s does
// not crash anything — it just makes every customer receive the generic
// fallback reply while the system looks healthy — so it has to be shouted
// about at boot or nobody finds out. Best-effort: a failure to run the check
// itself must never stop the workers from processing messages.
preflightModels()
  .then((results) => {
    for (const r of results) {
      if (r.ok) {
        logger.info({ model: r.model, tenants: r.tenants }, "Model preflight OK");
      } else {
        logger.error(
          { model: r.model, tenants: r.tenants, err: r.error },
          "MODEL PREFLIGHT FAILED — these tenants will fall back on every message until the model is fixed"
        );
      }
    }
  })
  .catch((err) => logger.warn({ err }, "Model preflight could not run"));

async function shutdown() {
  logger.info("Shutting down workers...");
  await Promise.all([
    inboundWorker.close(),
    broadcastWorker.close(),
    reindexWorker.close(),
    templateSyncWorker.close(),
  ]);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
