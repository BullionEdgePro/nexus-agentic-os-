import type { Job } from "bullmq";
import { withJobHeartbeat } from "@nexus/db";
import { bayutClient } from "../lib/bayut.js";
import { runBayutCycle, runBayutUnit } from "../services/bayut-sync.js";
import { logger } from "../lib/logger.js";

/**
 * The Bayut sync's two jobs (23 Nov 2026): the ten-minute cycle, which beats
 * its heartbeat (`bayut-sync`, stale after 45 minutes) so a dead sync is
 * noticed, and one unit's run half a minute after it changed. The counts are
 * logged: a cycle that ran and sent nothing looks healthy unless it says so.
 *
 * Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §10
 */
export async function processBayutSyncJob(job: Job<{ organizationId?: string; unitId?: string }>): Promise<void> {
  const opts = { client: bayutClient };
  if (job.name === "unit" && job.data.organizationId && job.data.unitId) {
    await runBayutUnit(job.data.organizationId, job.data.unitId, opts);
    return;
  }
  await withJobHeartbeat("bayut-sync", async () => {
    const result = await runBayutCycle(opts);
    if (result.steps > 0 || result.failed > 0) logger.info(result, "Bayut sync cycle");
  });
}
