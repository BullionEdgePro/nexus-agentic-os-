import { getPool } from "./client.js";
import {
  backtest,
  forecast,
  whyNotForecastable,
  HORIZON_DAYS,
  MIN_SCORED_FORECASTS,
  type Observation,
  type Prediction,
} from "@nexus/shared";

/**
 * Predictive BI (F11) — the data layer.
 *
 * Reads only `agent_quality_daily`, which is already rolled up per business per
 * day IN THAT BUSINESS'S OWN TIMEZONE (migration 019). That is not a convenience;
 * it is what makes weekday seasonality mean anything. A Dubai evening
 * conversation rolled up in UTC lands on the following day, and every Friday in
 * the series would be carrying a slice of Thursday.
 *
 * Writes only `forecasts` (migration 037), and only ever about days that have
 * not happened yet.
 *
 * See packages/shared/src/forecast.ts for the method and for why it calls no
 * model.
 */

/**
 * The metrics this platform is willing to make claims about.
 *
 * A fixed map rather than a caller-supplied column name, which is the same
 * decision the BI copilot makes about SQL and for a sharper version of the same
 * reason: this value reaches a query, and the identifier half of a query cannot
 * be parameterised. Adding a metric means adding a line here, on purpose.
 */
const METRIC_COLUMNS = {
  conversations: "conversations",
  escalated: "escalated",
} as const;

export type ForecastMetric = keyof typeof METRIC_COLUMNS;

export const FORECAST_METRICS = Object.keys(METRIC_COLUMNS) as ForecastMetric[];

/** What each metric means, in the words the screen will use. */
export const METRIC_LABELS: Record<ForecastMetric, string> = {
  conversations: "Conversations",
  escalated: "Conversations needing a person",
};

function columnFor(metric: ForecastMetric): string {
  const column = METRIC_COLUMNS[metric];
  // Not reachable through the type system, but this value is concatenated into
  // SQL, so it is checked at the point of concatenation rather than trusted to
  // have been checked upstream.
  if (!column) throw new Error(`Unknown forecast metric: ${metric}`);
  return column;
}

/**
 * Completed days only.
 *
 * `is_complete` is the difference between a forecast and a bad joke. A day still
 * in progress holds a few hours of traffic; included in the history it reads as
 * a collapse in volume, and because it is always the most recent point it would
 * drag every prediction down every single morning and recover every evening.
 * Migration 019 added that column for the chart; this is the place it earns its
 * keep.
 */
export async function getCompleteHistory(
  organizationId: string,
  metric: ForecastMetric,
  days = 120
): Promise<Observation[]> {
  const column = columnFor(metric);
  const { rows } = await getPool().query<{ day: string; value: number }>(
    `select day::text, ${column} as value
       from agent_quality_daily
      where organization_id = $1
        and is_complete
        and day > current_date - $2::integer
      order by day asc`,
    [organizationId, days]
  );

  return rows.map((row) => ({ day: row.day, value: Number(row.value) }));
}

/** The most recent day that has actually finished, in the business's timezone. */
export async function getLastCompleteDay(organizationId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ day: string | null }>(
    `select max(day)::text as day
       from agent_quality_daily
      where organization_id = $1 and is_complete`,
    [organizationId]
  );
  return rows[0]?.day ?? null;
}

/**
 * Stores predictions for days that have not happened yet.
 *
 * REFUSES ANYTHING ELSE, and returns how many it refused rather than throwing.
 * A forecast written about a day that has already begun is a memory wearing a
 * prediction's clothes; stored unchallenged it would be scored alongside real
 * ones and would be uncannily accurate, dragging the published error down
 * towards zero. The read path filters on `made_at` as well (see
 * `getForecastAccuracy`), so this refusal is the first of two independent
 * guards rather than the only one — migration 037 explains why it could not be
 * a CHECK constraint.
 *
 * Upsert rather than insert: the daily job re-runs, and a horizon-3 claim about
 * next Thursday made this morning replaces the one made this morning. It never
 * replaces the horizon-4 claim made yesterday, because the horizon is part of
 * the key — those are different claims and both deserve to be scored.
 */
export async function recordForecasts(
  organizationId: string,
  metric: ForecastMetric,
  predictions: Prediction[]
): Promise<{ written: number; refusedAsBackdated: number }> {
  let written = 0;
  let refusedAsBackdated = 0;

  for (const prediction of predictions) {
    const { rowCount } = await getPool().query(
      `insert into forecasts (
         organization_id, metric, target_day, horizon_days,
         predicted, interval_low, interval_high, baseline,
         method, history_days, made_at
       )
       -- EVERY PARAMETER IS CAST EXPLICITLY. In an INSERT ... SELECT the
       -- parameter types are resolved from the target columns, and it usually
       -- works — but "usually" is how the campaign engine shipped a draft that
       -- could never be created, because Postgres could not type one parameter
       -- and the failure only appeared the first time the statement ran. The
       -- casts cost nothing and remove the question.
       select $1::uuid, $2::text, $3::date, $4::smallint,
              $5::numeric, $6::numeric, $7::numeric, $8::numeric,
              $9::text, $10::smallint, now()
        from organizations o
       where o.id = $1
         -- The refusal, stated in SQL so it holds for every caller. The target
         -- day must not yet have begun where the business is; forecasting "today"
         -- from four hours of today is not forecasting.
         and now() < ($3::date::timestamp at time zone coalesce(o.timezone, 'UTC'))
       on conflict (organization_id, metric, target_day, horizon_days) do update
         set predicted     = excluded.predicted,
             interval_low  = excluded.interval_low,
             interval_high = excluded.interval_high,
             baseline      = excluded.baseline,
             method        = excluded.method,
             history_days  = excluded.history_days,
             made_at       = excluded.made_at
         -- Never re-open a claim that has already been marked against reality.
         -- Without this, a job re-running late would overwrite yesterday's
         -- prediction with one made after the fact and leave the old actual
         -- sitting beside it, producing a perfect score from a rewritten past.
         where forecasts.actual is null`,
      [
        organizationId,
        metric,
        prediction.targetDay,
        prediction.horizonDays,
        prediction.predicted,
        prediction.intervalLow,
        prediction.intervalHigh,
        prediction.baseline,
        prediction.method,
        prediction.historyDays,
      ]
    );

    if (rowCount && rowCount > 0) written++;
    else refusedAsBackdated++;
  }

  return { written, refusedAsBackdated };
}

/**
 * Fills in what actually happened, for every forecast whose day has closed.
 *
 * Runs over ALL unscored rows, not just yesterday's. A worker that was down for
 * two days would otherwise leave a permanent hole, and the missing days would be
 * exactly the ones where something unusual was happening.
 *
 * Note what is NOT here: any filter on how the forecast did. Scoring only the
 * good ones is not a mistake anybody makes deliberately, but a query that
 * quietly skipped rows with no matching rollup would have the same effect, so
 * the join is on the rollup being complete and nothing else.
 */
export async function scoreDueForecasts(organizationId: string): Promise<number> {
  let scored = 0;

  for (const metric of FORECAST_METRICS) {
    const column = columnFor(metric);
    const { rowCount } = await getPool().query(
      `update forecasts f
          set actual    = q.${column},
              scored_at = now()
         from agent_quality_daily q, organizations o
        where f.organization_id = $1
          and f.metric = $2
          and f.actual is null
          and q.organization_id = f.organization_id
          and q.day = f.target_day
          -- The rollup's own "this day has finished" flag, rather than a date
          -- comparison invented here. Two definitions of a finished day would
          -- eventually disagree by a few hours, and the disagreement would be
          -- invisible.
          and q.is_complete
          and o.id = f.organization_id`,
      [organizationId, metric]
    );
    scored += rowCount ?? 0;
  }

  return scored;
}

export interface ForecastAccuracy {
  metric: ForecastMetric;
  horizonDays: number;
  scored: number;
  /** Mean absolute error of what we committed to in advance. */
  methodMae: number;
  /** Mean absolute error of the naive baseline recorded at the same instant. */
  baselineMae: number;
  beatsBaseline: boolean;
  /** Share of actuals that fell inside the stated 80% interval. */
  insideInterval: number;
  /** False until MIN_SCORED_FORECASTS genuine predictions exist at this horizon. */
  publishable: boolean;
}

/**
 * How the forecasts we actually committed to have done.
 *
 * THE FILTER ON `made_at` IS THE POINT OF THIS FUNCTION and it lives here, in
 * the read path, rather than in whatever calls it — the same placement decision
 * as F5's two-tenant guard, made for the same reason. A row inserted by hand, or
 * by some future caller that skipped `recordForecasts`, can sit in this table
 * describing a day that had already happened. It simply never counts. There is
 * no code path that produces an accuracy figure including it.
 *
 * GROUPED BY HORIZON AND NEVER TOTALLED. A claim made overnight and one made six
 * days out are different claims of different difficulty; averaging them yields a
 * figure that improves whenever the job runs late, which is the opposite of what
 * an accuracy number is for.
 */
export async function getForecastAccuracy(organizationId: string): Promise<ForecastAccuracy[]> {
  const { rows } = await getPool().query<{
    metric: string;
    horizon_days: number;
    scored: string;
    method_mae: string | null;
    baseline_mae: string | null;
    inside: string;
  }>(
    `select f.metric,
            f.horizon_days,
            count(*)::text                                            as scored,
            avg(abs(f.predicted - f.actual))::numeric(10,3)::text      as method_mae,
            avg(abs(f.baseline  - f.actual))::numeric(10,3)::text      as baseline_mae,
            count(*) filter (
              where f.actual between f.interval_low and f.interval_high
            )::text                                                    as inside
       from forecasts f
       join organizations o on o.id = f.organization_id
      where f.organization_id = $1
        and f.actual is not null
        -- Genuine predictions only: said before the day it describes began,
        -- where the business is. See migration 037.
        and f.made_at < (f.target_day::timestamp at time zone coalesce(o.timezone, 'UTC'))
      group by f.metric, f.horizon_days
      order by f.metric, f.horizon_days`,
    [organizationId]
  );

  return rows
    .filter((row): row is typeof row & { metric: ForecastMetric } =>
      (FORECAST_METRICS as string[]).includes(row.metric)
    )
    .map((row) => {
      const scored = Number(row.scored);
      const methodMae = Number(row.method_mae ?? 0);
      const baselineMae = Number(row.baseline_mae ?? 0);
      return {
        metric: row.metric,
        horizonDays: row.horizon_days,
        scored,
        methodMae,
        baselineMae,
        // Strictly better, as in the backtest. A tie means the machinery bought
        // nothing.
        beatsBaseline: methodMae < baselineMae,
        insideInterval: scored > 0 ? Number(row.inside) / scored : 0,
        publishable: scored >= MIN_SCORED_FORECASTS,
      };
    });
}

export interface StoredForecast {
  metric: ForecastMetric;
  targetDay: string;
  horizonDays: number;
  predicted: number;
  intervalLow: number;
  intervalHigh: number;
  baseline: number;
  historyDays: number;
  madeAt: string;
}

/**
 * The claims currently outstanding — days not yet arrived.
 *
 * Reads what was STORED rather than recomputing on the fly. Recomputing would be
 * one fewer table and would quietly destroy the feature: the number on the
 * screen would always be the method's current opinion, so it could never be
 * caught having changed its mind, and "what did you say on Monday?" would have
 * no answer.
 */
export async function getUpcomingForecasts(organizationId: string): Promise<StoredForecast[]> {
  const { rows } = await getPool().query<{
    metric: string;
    target_day: string;
    horizon_days: number;
    predicted: string;
    interval_low: string;
    interval_high: string;
    baseline: string;
    history_days: number;
    made_at: string;
  }>(
    `select f.metric, f.target_day::text, f.horizon_days,
            f.predicted::text, f.interval_low::text, f.interval_high::text,
            f.baseline::text, f.history_days, f.made_at::text
       from forecasts f
       join organizations o on o.id = f.organization_id
      where f.organization_id = $1
        and f.actual is null
        -- Still in the future where the business is. A day that has begun is no
        -- longer a forecast; it is either scored or it is late.
        and now() < (f.target_day::timestamp at time zone coalesce(o.timezone, 'UTC'))
      order by f.metric, f.target_day asc`,
    [organizationId]
  );

  return rows
    .filter((row): row is typeof row & { metric: ForecastMetric } =>
      (FORECAST_METRICS as string[]).includes(row.metric)
    )
    .map((row) => ({
      metric: row.metric,
      targetDay: row.target_day,
      horizonDays: row.horizon_days,
      predicted: Number(row.predicted),
      intervalLow: Number(row.interval_low),
      intervalHigh: Number(row.interval_high),
      baseline: Number(row.baseline),
      historyDays: row.history_days,
      madeAt: row.made_at,
    }));
}

/**
 * The last few days we can now mark ourselves against.
 *
 * Exists so the screen can show misses next to predictions rather than only an
 * aggregate. An average error of 2.4 is abstract; "we said 9, it was 3" is the
 * thing that tells somebody whether to trust next week's number.
 */
export interface ScoredForecast extends StoredForecast {
  actual: number;
  error: number;
  baselineError: number;
}

export async function getRecentlyScored(
  organizationId: string,
  limit = 14
): Promise<ScoredForecast[]> {
  const { rows } = await getPool().query<{
    metric: string;
    target_day: string;
    horizon_days: number;
    predicted: string;
    interval_low: string;
    interval_high: string;
    baseline: string;
    history_days: number;
    made_at: string;
    actual: number;
  }>(
    `select f.metric, f.target_day::text, f.horizon_days,
            f.predicted::text, f.interval_low::text, f.interval_high::text,
            f.baseline::text, f.history_days, f.made_at::text, f.actual
       from forecasts f
       join organizations o on o.id = f.organization_id
      where f.organization_id = $1
        and f.actual is not null
        and f.made_at < (f.target_day::timestamp at time zone coalesce(o.timezone, 'UTC'))
      order by f.target_day desc, f.metric, f.horizon_days
      limit $2`,
    [organizationId, limit]
  );

  return rows
    .filter((row): row is typeof row & { metric: ForecastMetric } =>
      (FORECAST_METRICS as string[]).includes(row.metric)
    )
    .map((row) => ({
      metric: row.metric,
      targetDay: row.target_day,
      horizonDays: row.horizon_days,
      predicted: Number(row.predicted),
      intervalLow: Number(row.interval_low),
      intervalHigh: Number(row.interval_high),
      baseline: Number(row.baseline),
      historyDays: row.history_days,
      madeAt: row.made_at,
      actual: row.actual,
      error: Math.abs(Number(row.predicted) - row.actual),
      baselineError: Math.abs(Number(row.baseline) - row.actual),
    }));
}

export interface MetricReadiness {
  metric: ForecastMetric;
  label: string;
  historyDays: number;
  activeDays: number;
  /** Why nothing can be forecast for this metric, or null when something can. */
  blockedBecause: string | null;
  /** The method's measured error on this business's own past. Null when blocked. */
  backtest: {
    days: number;
    methodMae: number;
    baselineMae: number;
    beatsBaseline: boolean;
  } | null;
}

export interface ForecastStatus {
  lastCompleteDay: string | null;
  horizonDays: number;
  metrics: MetricReadiness[];
}

/**
 * Whether this business can be forecast at all, and if not, which sentence to
 * show instead.
 *
 * Modelled directly on F5's `getBrainStatus`, because the failure it guards
 * against is the same one: an empty screen that could equally mean "not enough
 * data yet" or "this has been broken since it shipped". Four of five businesses
 * here have no customers, so the empty case is the NORMAL case and will be for
 * some time — which makes the sentence explaining it the most-read part of this
 * feature rather than an error path.
 */
export async function getForecastStatus(organizationId: string): Promise<ForecastStatus> {
  const lastCompleteDay = await getLastCompleteDay(organizationId);
  const metrics: MetricReadiness[] = [];

  for (const metric of FORECAST_METRICS) {
    const history = await getCompleteHistory(organizationId, metric);
    const blockedBecause = whyNotForecastable(history);
    const scored = blockedBecause === null ? backtest(history) : null;

    metrics.push({
      metric,
      label: METRIC_LABELS[metric],
      historyDays: history.length,
      activeDays: history.filter((point) => point.value > 0).length,
      blockedBecause,
      backtest: scored
        ? {
            days: scored.days,
            methodMae: Math.round(scored.methodMae * 100) / 100,
            baselineMae: Math.round(scored.baselineMae * 100) / 100,
            beatsBaseline: scored.beatsBaseline,
          }
        : null,
    });
  }

  return { lastCompleteDay, horizonDays: HORIZON_DAYS, metrics };
}

/**
 * Produce and store this business's forecasts for every metric.
 *
 * Scoring runs FIRST, in the caller (see the forecast-run service), so today's
 * predictions are made by a method whose error has already been updated with
 * yesterday's result. The other order works and is subtly worse: the interval
 * shown would always be one day stale, and on the day something changed it would
 * be stale in exactly the way that matters.
 */
export async function produceForecasts(
  organizationId: string
): Promise<{ written: number; refusedAsBackdated: number; blocked: number }> {
  const lastCompleteDay = await getLastCompleteDay(organizationId);
  if (!lastCompleteDay) return { written: 0, refusedAsBackdated: 0, blocked: FORECAST_METRICS.length };

  let written = 0;
  let refusedAsBackdated = 0;
  let blocked = 0;

  for (const metric of FORECAST_METRICS) {
    const history = await getCompleteHistory(organizationId, metric);
    const predictions = forecast(history, lastCompleteDay);

    // `forecast` returns nothing when the series is not forecastable. Counted
    // rather than logged away, so "the job ran and wrote nothing" is
    // distinguishable from "the job did not run".
    if (predictions.length === 0) {
      blocked++;
      continue;
    }

    const result = await recordForecasts(organizationId, metric, predictions);
    written += result.written;
    refusedAsBackdated += result.refusedAsBackdated;
  }

  return { written, refusedAsBackdated, blocked };
}
