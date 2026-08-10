import { syncAllTemplates } from "../services/template-sync.js";
import { logger } from "../lib/logger.js";

/**
 * Re-reads every business's templates from Meta.
 *
 * The whole job of this cycle is to notice a status change we were never told
 * about — a PENDING template becoming APPROVED, or an approved one being paused
 * after a quality complaint. Both change what the product may do, and neither
 * arrives as a webhook.
 */
export async function processTemplateSyncJob(): Promise<void> {
  const results = await syncAllTemplates();

  const approved = results.reduce((total, result) => total + result.approved, 0);
  const retired = results.reduce((total, result) => total + result.retired, 0);

  // Logged as a count rather than "done", because "the job ran" is not evidence
  // that anything was read — a sync that reached Meta and got an empty list
  // looks identical to a healthy one unless the numbers are stated.
  logger.info(
    { businesses: results.length, approved, retired },
    "Template sync cycle complete"
  );
}
