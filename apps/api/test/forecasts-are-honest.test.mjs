// F11 Predictive BI — and the only question worth asking of it.
//
// Every other feature on this platform fails visibly enough to be caught by
// somebody eventually. A forecast does not. It always produces a number, it
// never errors, and it is not even wrong until the day it named arrives. The
// architecture doc calls this feature "numerology" on one live tenant, and a
// chart of seven confident bars drawn from three weeks of one business's
// history is exactly what that word means.
//
// So these tests are not about whether the arithmetic is correct. They are
// about whether the thing can lie — by predicting from history that cannot
// support it, by scoring itself on days it had already seen, by quietly beating
// a baseline it never recorded, or by publishing an accuracy figure it has not
// earned.
//
// The math tests RUN the real functions rather than reading their source, for
// the reason F5 wrote down: source text cannot tell you what a function
// returns, and a plausible wrong number is this system's signature failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  seasonalMedian,
  seasonalNaive,
  backtest,
  forecast,
  whyNotForecastable,
  addDays,
  MIN_HISTORY_DAYS,
  MIN_ACTIVE_DAYS,
  MIN_BACKTEST_DAYS,
  MIN_SCORED_FORECASTS,
  HORIZON_DAYS,
} from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const MATH = read("packages", "shared", "src", "forecast.ts");
const DB = read("packages", "db", "src", "forecasts.ts");
const MIGRATION = read("packages", "db", "migrations", "037-forecasts.sql");
const CLIENT = read("packages", "db", "src", "client.ts");
const SERVICE = read("apps", "api", "src", "services", "forecast-run.ts");
const QUEUE = read("apps", "api", "src", "queue", "forecast-queue.ts");
const ROUTE = read("apps", "api", "src", "routes", "forecasts.ts");
const PAGE = read("apps", "web", "app", "deck", "forecast", "page.tsx");

/** A series long enough to forecast: `weeks` weeks ending on a Sunday. */
function series(weeks, valueFor) {
  const points = [];
  // 2026-01-05 is a Monday, so weekday alignment in these fixtures is stable
  // rather than dependent on when the suite happens to run.
  let day = "2026-01-05";
  for (let index = 0; index < weeks * 7; index++) {
    points.push({ day, value: valueFor(index, day) });
    day = addDays(day, 1);
  }
  return points;
}

const weekdayOf = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();

// A realistic Gulf working week: quiet Friday and Saturday, busy midweek.
const BUSY_WEEK = [12, 14, 13, 15, 3, 2, 11]; // Sun..Sat by getUTCDay index
const realistic = (weeks) => series(weeks, (_index, day) => BUSY_WEEK[weekdayOf(day)]);

// ============================================================
// It refuses to predict from history that cannot support it
// ============================================================

test("a short history is refused, and says how short", () => {
  const short = series(2, () => 10);
  const why = whyNotForecastable(short);
  assert.ok(why, "two weeks must not be forecastable");
  assert.match(why, /14 complete days/);
  assert.match(why, new RegExp(String(MIN_HISTORY_DAYS)));
  assert.deepEqual(forecast(short, "2026-01-18"), []);
});

test("a business with no customers is refused even when the series is long", () => {
  // THE GUARD THAT MATTERS MOST ON THIS PLATFORM. Four of five businesses have
  // no traffic, so their history is months of zero — which passes the length
  // check, backtests perfectly (predicting zero is exactly right every time),
  // and would render a confident flat forecast with a tight interval and a
  // glowing accuracy score. That output is not useless, it is convincing.
  const silent = series(12, () => 0);
  assert.ok(silent.length > MIN_HISTORY_DAYS);
  const why = whyNotForecastable(silent);
  assert.ok(why, "an all-zero series must not be forecastable");
  assert.match(why, /no customer conversations at all/);
  assert.deepEqual(forecast(silent, "2026-03-29"), []);
});

test("a mostly-silent business is refused, and the count is the reason", () => {
  // Long enough, not empty, still mostly predicting silence.
  const sparse = series(12, (index) => (index % 14 === 0 ? 4 : 0));
  const why = whyNotForecastable(sparse);
  assert.ok(why);
  assert.match(why, /saw any conversation/);
  assert.match(why, new RegExp(String(MIN_ACTIVE_DAYS)));
});

test("the refusal is inside forecast(), not left to the caller", () => {
  // A guard the caller has to remember is a guard that holds until the second
  // caller. Same placement decision as F5's two-tenant filter.
  const forecastBody = MATH.slice(MATH.indexOf("export function forecast("));
  assert.match(forecastBody, /if \(whyNotForecastable\(history\) !== null\) return \[\]/);
});

test("a healthy business IS forecast, so the guards are not simply refusing everything", () => {
  // The counterweight to every test above. A feature that refused unconditionally
  // would pass all of them.
  const healthy = realistic(12);
  assert.equal(whyNotForecastable(healthy), null);
  const predictions = forecast(healthy, healthy[healthy.length - 1].day);
  assert.equal(predictions.length, HORIZON_DAYS);
  assert.ok(predictions.every((row) => row.predicted >= 0));
});

// ============================================================
// The method is the weekday, and the weekday is the whole signal
// ============================================================

test("the weekday pattern is followed rather than flattened into an average", () => {
  const healthy = realistic(12);
  const last = healthy[healthy.length - 1].day;
  const predictions = forecast(healthy, last);

  for (const row of predictions) {
    assert.equal(
      row.predicted,
      BUSY_WEEK[weekdayOf(row.targetDay)],
      `${row.targetDay} should follow its own weekday, not the weekly mean`
    );
  }
});

test("one freak day does not move the forecast", () => {
  // Median, not mean. A broadcast or a viral post should not reshape next
  // month's staffing.
  const withSpike = realistic(12).map((point, index) =>
    index === 40 ? { ...point, value: 400 } : point
  );
  const predictions = forecast(withSpike, withSpike[withSpike.length - 1].day);
  assert.ok(
    predictions.every((row) => row.predicted < 20),
    "a single 400-conversation day must not drag every prediction upward"
  );
});

test("a weekday never seen returns null rather than zero", () => {
  // "We have never seen a Tuesday" is a different statement from "Tuesdays are
  // quiet", and flattening the first into the second invents a fact.
  const mondaysOnly = [{ day: "2026-01-05", value: 9 }];
  assert.equal(seasonalMedian(mondaysOnly, "2026-01-06"), null);
  assert.equal(seasonalMedian(mondaysOnly, "2026-01-12"), 9);
});

test("the interval is clamped at zero", () => {
  const noisy = series(12, (_index, day) => (weekdayOf(day) === 5 ? 0 : 9));
  const predictions = forecast(noisy, noisy[noisy.length - 1].day);
  assert.ok(
    predictions.every((row) => row.intervalLow >= 0),
    "a count cannot be negative, and an interval starting at -3 advertises that nobody checked"
  );
});

// ============================================================
// The backtest cannot see the answer
// ============================================================

test("each backtested day is predicted only from the days before it", () => {
  // THE LOAD-BEARING PROPERTY OF THE WHOLE FEATURE. Fitting on the entire series
  // and then measuring error inside it is how a forecast scores brilliantly in a
  // report and badly in the world.
  //
  // Constructed so in-sample and out-of-sample disagree loudly: the series is
  // flat at 5, then permanently jumps to 50 halfway through. A method that could
  // see the whole series would carry some of the 50s backwards; one that cannot
  // must be badly wrong across the jump.
  const shifting = series(16, (index) => (index < 56 ? 5 : 50));
  const scored = backtest(shifting);
  assert.ok(scored.days > 0);
  assert.ok(
    scored.methodMae > 0,
    "a method scoring zero error across a regime change has seen the answer"
  );

  const bodyStart = MATH.indexOf("export function backtest(");
  const body = MATH.slice(bodyStart, MATH.indexOf("export interface Prediction"));
  assert.match(body, /history\.slice\(0, index\)/);
  assert.ok(
    !/seasonalMedian\(history,/.test(body),
    "the backtest must forecast from the days seen so far, never from the full series"
  );
});

test("the baseline is scored over exactly the same days as the method", () => {
  // Two error figures computed over different windows cannot be compared, and
  // comparing them anyway is how the method always wins.
  const body = MATH.slice(MATH.indexOf("export function backtest("));
  assert.match(body, /if \(predicted === null \|\| naive === null\) continue/);

  const scored = backtest(realistic(12));
  assert.ok(scored.days > 0);
  assert.ok(Number.isFinite(scored.methodMae) && Number.isFinite(scored.baselineMae));
});

test("a tie goes to the baseline", () => {
  // A tie means the extra machinery bought nothing, and the simpler claim is the
  // one to make. On a perfectly regular series both methods are exactly right,
  // so this is the case that would otherwise silently credit the method.
  const perfect = realistic(12);
  const scored = backtest(perfect);
  assert.equal(scored.methodMae, scored.baselineMae);
  assert.equal(scored.beatsBaseline, false, "equal error must not read as beating the baseline");
});

test("losing to the baseline is a publishable result, not a hidden one", () => {
  // The screen must be able to say so, and in the same size type.
  assert.match(PAGE, /not beating a naive guess/);
  assert.match(MATH, /False is a publishable result/);
});

test("a thin backtest blocks the forecast even when the history is long enough", () => {
  assert.match(MATH, new RegExp(`MIN_BACKTEST_DAYS = ${MIN_BACKTEST_DAYS}`));
  const why = whyNotForecastable(series(5, (_i, day) => BUSY_WEEK[weekdayOf(day)]));
  // Five weeks: 35 days, so 7 days of rolling origin — under the threshold.
  assert.ok(why);
  assert.match(why, /has only been tested against/);
});

// ============================================================
// It cannot mark its own homework
// ============================================================

test("the baseline is stored with every forecast, not recomputed later", () => {
  // Recomputed after the fact, the comparison could be made from data the
  // baseline never had. Stored at prediction time, the question "was this worth
  // running?" is arithmetic.
  assert.match(MIGRATION, /baseline\s+numeric\(10,2\) not null/);
  assert.match(DB, /insert into forecasts \(/);
  assert.match(DB, /baseline,/);
  const bars = PAGE.slice(PAGE.indexOf("function ForecastBars"));
  assert.ok(bars.length > 0);
});

test("a forecast can only be written about a day that has not begun", () => {
  // In SQL, so it holds for every caller rather than for the one that
  // remembered. A forecast written about a day that has already happened is a
  // memory wearing a prediction's clothes, and scored alongside real ones it
  // would be uncannily accurate.
  const writer = DB.slice(DB.indexOf("export async function recordForecasts"));
  assert.match(writer, /now\(\) < \(\$3::date::timestamp at time zone coalesce\(o\.timezone, 'UTC'\)\)/);
});

test("the upsert never re-opens a forecast that has already been scored", () => {
  // Otherwise a late job overwrites yesterday's prediction with one made after
  // the fact, leaving the old `actual` beside it — a perfect score from a
  // rewritten past.
  const writer = DB.slice(DB.indexOf("export async function recordForecasts"));
  assert.match(writer, /where forecasts\.actual is null/);
});

test("the accuracy read counts only claims made before their day began", () => {
  // THE SECOND, INDEPENDENT GUARD, and the one that holds even if a row is
  // inserted by hand. It lives in the read path rather than the caller, exactly
  // as F5's two-tenant filter does.
  const reader = DB.slice(
    DB.indexOf("export async function getForecastAccuracy"),
    DB.indexOf("export interface StoredForecast")
  );
  assert.match(reader, /f\.made_at < \(f\.target_day::timestamp at time zone/);
});

test("accuracy is never totalled across horizons", () => {
  // A claim made overnight and one made six days out are different claims of
  // different difficulty. Averaged, the figure improves whenever the job runs
  // late — which is the opposite of what an accuracy number is for.
  const reader = DB.slice(DB.indexOf("export async function getForecastAccuracy"));
  assert.match(reader, /group by f\.metric, f\.horizon_days/);
  assert.match(MIGRATION, /primary key \(organization_id, metric, target_day, horizon_days\)/);
});

test("a live accuracy figure has to be earned before it is shown", () => {
  assert.match(MATH, new RegExp(`MIN_SCORED_FORECASTS = ${MIN_SCORED_FORECASTS}`));
  assert.match(DB, /publishable: scored >= MIN_SCORED_FORECASTS/);
  // And the screen must not fill the gap with the backtest under an accuracy
  // heading, which is the tempting thing to do and would erase the distinction
  // the feature rests on.
  assert.match(PAGE, /Not checked yet/);
  assert.match(PAGE, /marking its own homework/);
});

test("scoring cannot skip the days that went badly", () => {
  // Nobody does this deliberately; a join that quietly dropped rows would have
  // the same effect. The only conditions are that the day has closed and the
  // rollup says so.
  const scorer = DB.slice(
    DB.indexOf("export async function scoreDueForecasts"),
    DB.indexOf("export interface ForecastAccuracy")
  );
  assert.match(scorer, /f\.actual is null/);
  assert.match(scorer, /q\.is_complete/);
  assert.ok(
    !/predicted|error|abs\(/.test(scorer),
    "scoring must not look at how the forecast did before deciding to score it"
  );
});

test("the table cannot forget its misses", () => {
  // A reporting feature that can quietly drop its own wrong rows will report
  // 100% accuracy forever while being useless.
  assert.match(MIGRATION, /grant select, insert, update on forecasts to nexus_app/);
  assert.ok(
    !/grant[^;]*delete[^;]*on forecasts/i.test(MIGRATION),
    "nexus_app must not be able to delete a forecast"
  );
});

// ============================================================
// History it reads, and history it must not
// ============================================================

test("only completed days are used as history", () => {
  // A day still in progress holds a few hours of traffic. Included, it reads as
  // a collapse in volume — and being always the most recent point, it would drag
  // every prediction down every morning and recover every evening.
  const history = DB.slice(
    DB.indexOf("export async function getCompleteHistory"),
    DB.indexOf("export async function getLastCompleteDay")
  );
  assert.match(history, /and is_complete/);
  assert.match(DB, /and is_complete/);
});

test("the metric never reaches SQL as a caller-supplied string", () => {
  // The identifier half of a query cannot be parameterised, so it comes from a
  // fixed map — the same decision the BI copilot makes about SQL itself.
  assert.match(DB, /const METRIC_COLUMNS = \{/);
  assert.match(DB, /function columnFor\(metric: ForecastMetric\): string/);
  assert.match(DB, /if \(!column\) throw new Error/);
});

test("upcoming forecasts are read back, not recomputed on the fly", () => {
  // Recomputing would be one fewer table and would destroy the feature: the
  // number on screen would always be the method's current opinion, so it could
  // never be caught having changed its mind.
  const reader = DB.slice(DB.indexOf("export async function getUpcomingForecasts"));
  assert.match(reader, /from forecasts f/);
  assert.ok(!/seasonalMedian|forecast\(/.test(reader.slice(0, reader.indexOf("return rows"))));
});

// ============================================================
// Tenant isolation, and the schedule
// ============================================================

test("forecasts is tenant-scoped, in the guard list and behind an RLS policy", () => {
  // Two law firms answer on the same WhatsApp number; neither may read the
  // other's volume. The guard list is hand-maintained, so a table missing from
  // it is silently uncovered.
  assert.match(CLIENT, /"forecasts",/);
  assert.match(MIGRATION, /alter table forecasts enable row level security/);
  assert.match(MIGRATION, /create policy forecasts_tenant_isolation on forecasts/);
});

test("the daily cycle runs inside a tenant context per business", () => {
  // Unscoped under RLS this would not error — it would read and write nothing,
  // which is the failure shape this platform specialises in.
  assert.match(SERVICE, /withTenant\(organization\.id/);
});

test("one business failing does not abandon the rest", () => {
  const loop = SERVICE.slice(SERVICE.indexOf("for (const organization of organizations)"));
  assert.match(loop, /catch \(err\)/);
  assert.match(loop, /Forecast cycle failed/);
});

test("scoring runs before predicting", () => {
  // So today's forecast is made by a method whose published error already
  // includes yesterday. The other order works and is stale in exactly the way
  // that matters on the day something changed.
  const body = SERVICE.slice(SERVICE.indexOf("withTenant(organization.id"));
  assert.ok(
    body.indexOf("scoreDueForecasts") < body.indexOf("produceForecasts"),
    "scoreDueForecasts must run before produceForecasts"
  );
});

test("the cycle is daily, and the interval is part of the measurement", () => {
  // Re-made hourly, the horizon-1 row is overwritten twenty-four times and the
  // version that stands is whichever ran last — closest to the event, made from
  // the most information. Every accuracy figure would improve for no reason
  // connected to the method.
  assert.match(QUEUE, /const EVERY_DAY_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(QUEUE, /graded on hindsight|closest to the event/);
});

test("a backdated write is counted and shouted about rather than swallowed", () => {
  // It should never happen — the writer only names future days — so if it does,
  // it is a clock or timezone defect, and it would otherwise be perfectly
  // silent.
  assert.match(DB, /refusedAsBackdated/);
  assert.match(SERVICE, /Forecast refused as backdated/);
});

// ============================================================
// The screen says what it does not know
// ============================================================

test("the route ships the refusal alongside the forecasts", () => {
  // Behind a second request, the empty state — which is the normal state here —
  // would render before its explanation arrived.
  assert.match(ROUTE, /getForecastStatus/);
  const handler = ROUTE.slice(ROUTE.indexOf('forecastsRoute.get("/:slug/forecast"'));
  assert.match(handler, /status,/);
});

test("it is mounted per organization so RLS has a tenant to enforce against", () => {
  const INDEX = read("apps", "api", "src", "index.ts");
  assert.match(INDEX, /app\.route\("\/api\/organizations", forecastsRoute\)/);
});

test("the empty screen explains itself rather than just being empty", () => {
  // The mistake F5 made, wrote down, and every screen since has inherited the
  // fix for. Here it is the normal case, not an error path.
  assert.match(PAGE, /Not forecasting this yet/);
  assert.match(PAGE, /blockedBecause/);
  assert.match(PAGE, /designed\s+behaviour rather than a fault/);
});

test("the page states what the method cannot know", () => {
  // Campaigns, public holidays, a competitor closing. On a page of
  // confident-looking numbers this is the sentence most worth reading.
  assert.match(PAGE, /public\s+holiday/);
  assert.match(PAGE, /competitor closing/);
  console.log(
    "PASS: forecasts refuse thin history, are scored against a stored naive baseline, and cannot mark their own homework"
  );
});
