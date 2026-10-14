import type { Job } from "bullmq";
import { listHqBusinesses, getHqProfile, withJobHeartbeat } from "@nexus/db";
import { runHqChecks } from "../services/hq-checks.js";
import { judgeBusiness } from "../services/hq-state.js";
import { notifyOwnersOfHqCritical } from "../services/push-dispatcher.js";
import { logger } from "../lib/logger.js";
import type { HqChecksJob } from "./hq-checks-queue.js";

/**
 * Run the website checks for one business ("Check now") or every business
 * (the 06:00 run), then tell the owner about anything now critical. One
 * business failing never stops the others.
 */
async function processHqChecksJobBody(job: Job<HqChecksJob>): Promise<void> {
  const businesses = (await listHqBusinesses())
    .filter((b) => b.isActive && b.slug !== "review-demo")
    .filter((b) => !job.data.organizationId || b.id === job.data.organizationId);

  for (const business of businesses) {
    try {
      // The address an admin typed in Business HQ wins over the one on the
      // business record: it is the one they are asking about.
      const profile = await getHqProfile(business.id);
      await runHqChecks({ id: business.id, websiteUrl: profile?.domain || business.websiteUrl });
      const { issues, score } = await judgeBusiness(business.id);
      const critical = issues.filter((issue) => issue.severity === "critical");
      if (critical.length) await notifyOwnersOfHqCritical({ id: business.id, name: business.name }, critical);
      logger.info({ business: business.slug, score, critical: critical.length }, "Business HQ checks complete");
    } catch (err) {
      logger.error({ business: business.slug, err }, "Business HQ checks failed for one business");
    }
  }
}

export function processHqChecksJob(job: Job<HqChecksJob>): Promise<void> {
  return withJobHeartbeat("hq-checks", () => processHqChecksJobBody(job));
}
