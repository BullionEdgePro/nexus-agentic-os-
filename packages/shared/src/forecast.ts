/**
 * The forecasting method (F11), and the backtest that decides whether it is
 * allowed to say anything.
 *
 * PURE ON PURPOSE. No database, no clock, no model. Everything here is a
 * function of the series it is handed, which means the tests exercise the real
 * method rather than a description of it — the lesson from F5, where four
 * processor tests mocked the classifier wholesale and would have passed over a
 * stub.
 *
 * NO MODEL CALL, and that is a design decision rather than a saving. F8's
 * operators call no model either, for the reason §7 gives: inference cost scales
 * with tenants and the reply path is the one thing that must never degrade. But
 * there is a second reason specific to this feature. A model asked to predict a
 * number will always return one, fluently, with no way to ask it what its error
 * distribution is — and the entire value of what follows is the error
 * distribution. Arithmetic can be backtested. A paragraph cannot.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE METHOD: median of that weekday, over recent history.
 *
 * Deliberately, almost insultingly simple, and each part of it is a refusal:
 *
 *   By weekday, because weekly seasonality is the whole signal in business
 *   messaging traffic. In Dubai the working week collapses on Friday and
 *   Saturday, so a flat average predicts a busy Friday and a quiet Tuesday, and
 *   is wrong in both directions every single week.
 *
 *   Median, not mean, because one viral day or one broadcast should not move
 *   next month's staffing. A mean over four observations is moved a long way by
 *   one of them.
 *
 *   No trend term. With four weeks of history there are four observations of
 *   each weekday, and a slope fitted to four points is fitting noise — it would
 *   produce confident growth or collapse out of nothing and be impossible to
 *   argue with. When there is a year of history this is the first thing to
 *   revisit; today it would be decoration.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** One complete day of history. `value` is a count; `day` is ISO yyyy-mm-dd. */
export interface Observation {
  day: string;
  value: number;
}

/**
 * Four observations of every weekday. Below this the weekday medians are drawn
 * from three points or fewer, and a median of three is the middle of three.
 */
export const MIN_HISTORY_DAYS = 28;

/**
 * Days that actually saw traffic, anywhere in the window.
 *
 * THE GUARD THAT MATTERS MORE THAN THE LENGTH ONE. Four of this platform's five
 * businesses have no customers, so their history is 28 days of zero — which
 * satisfies MIN_HISTORY_DAYS, backtests perfectly (predicting zero is exactly
 * right every time), and would render a confident flat forecast with a tight
 * interval and a glowing accuracy score. That output is not merely useless, it
 * is the most convincing wrong thing this feature could produce.
 */
export const MIN_ACTIVE_DAYS = 10;

/** How far ahead a claim is made. A fortnight would be honest only about noise. */
export const HORIZON_DAYS = 7;

/**
 * Backtest days required before a forecast may be shown at all.
 *
 * The interval and the baseline comparison both come out of the backtest, so a
 * backtest over three days would hand back an interval computed from three
 * residuals — a number with the shape of a confidence bound and none of the
 * content.
 */
export const MIN_BACKTEST_DAYS = 14;

/**
 * Genuine predictions that must have been scored before a LIVE accuracy figure
 * is published, per metric and per horizon.
 *
 * Separate from MIN_BACKTEST_DAYS, and the distinction is the one this whole
 * feature turns on. The backtest is the method marking its own homework against
 * history it can see; it gates whether a forecast may be shown at all. This gates
 * the other number — how the forecasts we actually committed to, in advance, in
 * writing, turned out. That one takes weeks to earn and cannot be fabricated,
 * and when the two disagree the backtest is the one that is wrong.
 */
export const MIN_SCORED_FORECASTS = 10;

export const METHOD = "seasonal_median_v1";
export const BASELINE_METHOD = "seasonal_naive";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/** UTC getter on a date-only string: no local-timezone drift across the boundary. */
function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * The method itself.
 *
 * Returns null when the requested weekday has never been observed — which is not
 * the same as predicting zero, and must not be flattened into it. A business
 * onboarded on a Wednesday has no Tuesday yet, and "we have never seen a
 * Tuesday" is a different statement from "Tuesdays are quiet".
 */
export function seasonalMedian(history: Observation[], targetDay: string): number | null {
  const weekday = weekdayOf(targetDay);
  const sameWeekday = history.filter((point) => weekdayOf(point.day) === weekday);
  if (sameWeekday.length === 0) return null;

  // Most recent eight occurrences — about two months. Older than that and a
  // business that has genuinely changed shape is averaged with what it used to
  // be, which is how a forecast ends up permanently lagging reality.
  const recent = sameWeekday.slice(-8).map((point) => point.value);
  return median(recent);
}

/**
 * The thing to beat: the same weekday, one week ago.
 *
 * Kept as a first-class function rather than a comment because it is scored and
 * STORED alongside every real forecast. A method is only worth running if it
 * beats this, and that question can only be answered later if the answer at the
 * time was written down.
 */
export function seasonalNaive(history: Observation[], targetDay: string): number | null {
  const weekAgo = addDays(targetDay, -7);
  const match = history.find((point) => point.day === weekAgo);
  return match ? match.value : null;
}

export interface Backtest {
  /** Days the rolling origin could actually evaluate. */
  days: number;
  /** Mean absolute error of the method, in whole units of the metric. */
  methodMae: number;
  /** Mean absolute error of "same weekday last week" over the identical days. */
  baselineMae: number;
  /** 80th percentile of absolute residuals, used as the interval half-width. */
  p80AbsoluteError: number;
  /**
   * Whether the method was better than the naive baseline over these days.
   *
   * False is a publishable result, not a failure to hide. It means the honest
   * thing to tell someone is "last Tuesday is as good a guess as we have".
   */
  beatsBaseline: boolean;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Rolling-origin backtest: for each day late enough to have MIN_HISTORY_DAYS
 * before it, predict it using ONLY the days before it, and compare.
 *
 * THE `slice(0, index)` IS THE ENTIRE POINT OF THIS FUNCTION. Fitting on the
 * whole series and then measuring error on days inside it is how a forecast
 * scores brilliantly in a report and badly in the world; the method has already
 * seen the answer. Every residual below comes from a prediction that could
 * genuinely have been made on the morning of that day.
 *
 * The baseline is scored over exactly the same days, never a longer or shorter
 * window. Two error figures computed over different periods cannot be compared,
 * and comparing them anyway is how the method always wins.
 */
export function backtest(history: Observation[]): Backtest {
  const methodErrors: number[] = [];
  const baselineErrors: number[] = [];

  for (let index = MIN_HISTORY_DAYS; index < history.length; index++) {
    const seen = history.slice(0, index);
    const target = history[index];

    const predicted = seasonalMedian(seen, target.day);
    const naive = seasonalNaive(seen, target.day);
    // Both or neither. Scoring a day the baseline could not reach would compare
    // the method's easy days against the baseline's hard ones.
    if (predicted === null || naive === null) continue;

    methodErrors.push(Math.abs(predicted - target.value));
    baselineErrors.push(Math.abs(naive - target.value));
  }

  const mean = (values: number[]) =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;

  const methodMae = mean(methodErrors);
  const baselineMae = mean(baselineErrors);

  return {
    days: methodErrors.length,
    methodMae,
    baselineMae,
    p80AbsoluteError: quantile([...methodErrors].sort((a, b) => a - b), 0.8),
    // Strictly better. A tie goes to the baseline, because a tie means the extra
    // machinery bought nothing and the simpler claim is the one to make.
    beatsBaseline: methodErrors.length > 0 && methodMae < baselineMae,
  };
}

export interface Prediction {
  targetDay: string;
  horizonDays: number;
  predicted: number;
  intervalLow: number;
  intervalHigh: number;
  baseline: number;
  method: string;
  historyDays: number;
}

/**
 * Why this series cannot be forecast, or null when it can.
 *
 * A sentence rather than an absence, for the reason F5's `blockedBecause`
 * exists: an empty screen is indistinguishable from a broken one unless it says
 * which it is. Ordered by which constraint actually binds first, so the reader
 * is sent to the thing that would help.
 */
export function whyNotForecastable(history: Observation[]): string | null {
  const activeDays = history.filter((point) => point.value > 0).length;

  if (history.length === 0) {
    return "There is no completed day of history for this business yet.";
  }
  if (history.length < MIN_HISTORY_DAYS) {
    return `Only ${history.length} complete days of history — ${MIN_HISTORY_DAYS} are needed before any weekday has been seen four times.`;
  }
  if (activeDays < MIN_ACTIVE_DAYS) {
    return activeDays === 0
      ? "This business has had no customer conversations at all, so there is nothing to project. A flat forecast of zero would be accurate and worthless."
      : `Only ${activeDays} of the last ${history.length} days saw any conversation. Below ${MIN_ACTIVE_DAYS}, a forecast is mostly predicting silence.`;
  }

  const scored = backtest(history);
  if (scored.days < MIN_BACKTEST_DAYS) {
    return `The method has only been tested against ${scored.days} past days here; ${MIN_BACKTEST_DAYS} are needed before its error is worth quoting.`;
  }

  return null;
}

/**
 * Forecast the next `HORIZON_DAYS` days after `lastCompleteDay`.
 *
 * Returns an empty list whenever `whyNotForecastable` has something to say. That
 * check is INSIDE this function rather than left to callers, which is the same
 * decision `getSharedGuidance` makes about its two-tenant filter and for the
 * same reason: a guard the caller has to remember is a guard that holds until
 * the second caller.
 */
export function forecast(history: Observation[], lastCompleteDay: string): Prediction[] {
  if (whyNotForecastable(history) !== null) return [];

  const scored = backtest(history);
  const predictions: Prediction[] = [];

  for (let horizon = 1; horizon <= HORIZON_DAYS; horizon++) {
    const targetDay = addDays(lastCompleteDay, horizon);
    const predicted = seasonalMedian(history, targetDay);
    const naive = seasonalNaive(history, targetDay);
    if (predicted === null) continue;

    predictions.push({
      targetDay,
      horizonDays: horizon,
      predicted: round2(predicted),
      // Clamped at zero: a count cannot be negative, and an interval whose lower
      // bound is -3 conversations advertises that nobody checked.
      intervalLow: round2(Math.max(0, predicted - scored.p80AbsoluteError)),
      intervalHigh: round2(predicted + scored.p80AbsoluteError),
      // Falls back to the method's own figure only when there is no day exactly
      // a week before the target. Never to zero, which would hand the method a
      // free win on any day the baseline cannot speak for.
      baseline: round2(naive ?? predicted),
      method: METHOD,
      historyDays: history.length,
    });
  }

  return predictions;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
