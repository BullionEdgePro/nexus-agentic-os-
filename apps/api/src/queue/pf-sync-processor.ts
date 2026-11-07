import type { Job } from "bullmq";
import { PF_LISTING_CALLS_READY } from "@nexus/shared";
import { withJobHeartbeat } from "@nexus/db";
import { pfClient } from "../lib/property-finder.js";
import { runPfCycle, runPfUnit } from "../services/pf-sync.js";
import { logger } from "../lib/logger.js";

/**
 * The Property Finder sync's two jobs (7 Nov 2026): the ten-minute cycle, which
 * beats its heartbeat (migration 050) so a dead sync is noticed, and one unit's
 * run half a minute after it changed. The counts are logged, as the template
 * sync's are: a cycle that ran and sent nothing looks healthy unless it says so.
 */
export async function processPfSyncJob(job: Job<{ organizationId?: string; unitId?: string }>): Promise<void> {
  const opts = { client: pfClient, ready: PF_LISTING_CALLS_READY };
  if (job.name === "unit" && job.data.organizationId && job.data.unitId) {
    await runPfUnit(job.data.organizationId, job.data.unitId, opts);
    return;
  }
  await withJobHeartbeat("pf-sync", async () => {
    const result = await runPfCycle(opts);
    if (result.steps > 0 || result.failed > 0) logger.info(result, "Property Finder sync cycle");
  });
}
