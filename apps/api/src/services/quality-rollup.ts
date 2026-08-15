import {
  listOrganizations,
  rollUpQualityDay,
  rollUpProcedureOutcomes,
  rollUpSharedPatterns,
  withTenant,
} from "@nexus/db";
import { logger } from "../lib/logger.js";

/**
 * Recomputes recent days for every business.
 *
 * Recent, not just yesterday. A conversation can gain a human reply days after
 * it started, which changes whether that day counts as escalated — so a rollup
 * written once and never revisited would freeze a wrong answer. Recomputing a
 * trailing window is cheap and self-healing: a day the job missed entirely,
 * because the worker was down or a deploy was mid-flight, is filled in by the
 * next run rather than staying a hole in the chart forever.
 */
const WINDOW_DAYS = 3;

export async function rollUpRecentQuality(windowDays = WINDOW_DAYS): Promise<number> {
  const organizations = await listOrganizations();
  let written = 0;

  for (const organization of organizations) {
    for (let back = 0; back < windowDays; back++) {
      const date = new Date();
      date.setUTCDate(date.getUTCDate() - back);
      const day = date.toISOString().slice(0, 10);

      try {
        await withTenant(organization.id, () => rollUpQualityDay(organization.id, day));
        written++;
      } catch (err) {
        // One business or one day failing must not abandon the rest. A thrown
        // error here would leave every organization after it in the list with
        // no rollup and no signal that it was skipped.
        logger.error({ organization: organization.slug, day, err }, "Quality rollup failed");
      }
    }

    // How the business's procedures are actually doing, recomputed from the
    // stamps the reply path left on the metric rows (migration 036).
    //
    // On this cycle rather than the daily inference one, because these are the
    // numbers a person reads while deciding whether to keep a procedure switched
    // on — and a figure that is up to 24 hours stale is one they would be right
    // to distrust. It is a single statement per business over an indexed
    // column, so hourly costs nothing.
    //
    // Outside the per-day loop: the counters are a running total over all of a
    // procedure's history, not a figure per day, and recomputing them three
    // times per business per run would just do identical work twice.
    try {
      await withTenant(organization.id, () => rollUpProcedureOutcomes(organization.id));
    } catch (err) {
      // Never fatal to the quality rollups above, which are the ones an owner
      // actually looks at.
      logger.error({ organization: organization.slug, err }, "Procedure outcome rollup failed");
    }
  }

  // The pooled patterns are derived from the same conversation outcomes, so
  // they are recomputed on the same cycle rather than on one of their own —
  // two schedules over one source would let the two views disagree, and the
  // disagreement would be invisible.
  try {
    const shared = await rollUpSharedPatterns();
    logger.info(shared, "Shared patterns recomputed");
  } catch (err) {
    // Never fatal to the per-tenant rollups above, which are the ones an owner
    // actually looks at.
    logger.error({ err }, "Shared pattern rollup failed");
  }

  logger.info({ organizations: organizations.length, dayRows: written }, "Quality rollup complete");
  return written;
}
