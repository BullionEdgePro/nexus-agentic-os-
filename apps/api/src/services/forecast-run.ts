import {
  listOrganizations,
  scoreDueForecasts,
  produceForecasts,
  withTenant,
} from "@nexus/db";
import { logger } from "../lib/logger.js";

/**
 * The daily forecast cycle (F11).
 *
 * TWO STEPS, AND THE ORDER IS LOAD-BEARING.
 *
 *   1. Score. Mark yesterday's claims against what actually happened.
 *   2. Predict. Make today's claims about the next seven days.
 *
 * Scoring first means today's forecast is produced by a method whose published
 * error already includes yesterday. Predicting first works too, and is quietly
 * worse: the interval on the screen would always be one day stale, and on the
 * day a business's traffic changed shape it would be stale in precisely the way
 * that matters.
 *
 * Daily rather than hourly, for the same reason procedure inference is. The
 * quality rollup recomputes numbers, so running it often costs correctness
 * nothing. This one WRITES DOWN A CLAIM, and a claim re-made every hour is not a
 * claim — the horizon-1 row for tomorrow would be overwritten twenty-four times
 * and the version that finally stood would be whichever ran last, made from the
 * most information. That is how a forecasting system accidentally grades itself
 * on hindsight.
 */
export interface ForecastRunResult {
  organizations: number;
  scored: number;
  written: number;
  refusedAsBackdated: number;
  /** Business-metric pairs that could not be forecast. The expected majority. */
  blocked: number;
}

export async function runForecastCycle(): Promise<ForecastRunResult> {
  const organizations = await listOrganizations();
  const result: ForecastRunResult = {
    organizations: organizations.length,
    scored: 0,
    written: 0,
    refusedAsBackdated: 0,
    blocked: 0,
  };

  for (const organization of organizations) {
    try {
      // Both steps inside one tenant context: `forecasts` is tenant-scoped and
      // RLS is enforcing, so an unscoped call here would not error — it would
      // return and write nothing, which is the failure shape this platform
      // specialises in. See the shared-number trap in the handoff.
      const outcome = await withTenant(organization.id, async () => {
        const scored = await scoreDueForecasts(organization.id);
        const produced = await produceForecasts(organization.id);
        return { scored, ...produced };
      });

      result.scored += outcome.scored;
      result.written += outcome.written;
      result.refusedAsBackdated += outcome.refusedAsBackdated;
      result.blocked += outcome.blocked;

      if (outcome.refusedAsBackdated > 0) {
        // Never expected. `produceForecasts` only ever names future days, so a
        // refusal here means either a clock disagreement between the app and
        // Postgres or a business whose timezone changed under us. Either way it
        // is a defect, and it would otherwise be perfectly silent — the counter
        // exists so it cannot be.
        logger.warn(
          { organization: organization.slug, refused: outcome.refusedAsBackdated },
          "Forecast refused as backdated — the writer named a day that had already begun"
        );
      }
    } catch (err) {
      // One business failing must not abandon the rest, exactly as in the
      // quality rollup. Without this, every organization after the failure gets
      // no forecast and no signal that it was skipped.
      logger.error({ organization: organization.slug, err }, "Forecast cycle failed");
    }
  }

  // `blocked` is the number to read on this line for the next few weeks, and it
  // is not an error. Four of five businesses have no customers and the fifth has
  // weeks rather than months of history, so almost every metric is correctly
  // refusing to predict. A run reporting written:0 blocked:10 is this feature
  // working.
  logger.info(result, "Forecast cycle complete");
  return result;
}
