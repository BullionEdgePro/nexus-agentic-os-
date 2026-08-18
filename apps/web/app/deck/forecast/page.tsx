"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getForecast,
  refreshForecast,
  type ForecastStatus,
  type StoredForecast,
  type ScoredForecast,
  type ForecastAccuracy,
  type MetricReadiness,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "./forecast.css";

/**
 * What's coming — predictive BI (F11).
 *
 * THIS SCREEN IS BUILT AROUND ITS REFUSALS, and that is not a hedge. A forecast
 * is the one output on this platform that cannot fail visibly: it always
 * produces a number, never errors, and is not even wrong until the day it named
 * arrives. ARCHITECTURE-ABOS.md calls this feature "numerology" on one live
 * tenant, and a chart of seven confident bars drawn from three weeks of one
 * business's history is exactly what that word describes.
 *
 * So three things are true of every number below.
 *
 * NOTHING IS SHOWN UNTIL THE METHOD HAS BEEN MARKED AGAINST THIS BUSINESS'S OWN
 * PAST. Not against a benchmark, not against another tenant. Where it has not
 * been, the sentence saying why takes the space the chart would have had.
 *
 * EVERY PREDICTION IS SHOWN NEXT TO THE DUMBEST ALTERNATIVE. "The same weekday
 * last week" is recorded at the moment each forecast is made, and if it is doing
 * better then this page says so in the same size type. A forecasting feature
 * that hides its baseline is selling the reader a credential.
 *
 * THE ACCURACY FIGURE IS EARNED, NOT COMPUTED ON DEMAND. It comes only from
 * claims written down before the day they describe. Until enough of those have
 * closed, this page says the honest thing — that it has not been checked yet —
 * rather than quietly showing the backtest under an accuracy heading.
 */
export default function ForecastPage() {
  const [business, setBusiness] = useState<BusinessSlug>(TENANTS[0].slug);
  const [status, setStatus] = useState<ForecastStatus | null>(null);
  const [upcoming, setUpcoming] = useState<StoredForecast[]>([]);
  const [accuracy, setAccuracy] = useState<ForecastAccuracy[]>([]);
  const [recent, setRecent] = useState<ScoredForecast[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /**
   * A LOAD that failed, kept apart from an ACTION that failed.
   *
   * The render below refuses to draw anything when this is set, because the
   * alternative is the previous business's numbers under the new one's name.
   * An action failure — a recompute, a send, a save — must NOT do that: the
   * screen it happened on is still correct, and blanking it would lose the
   * context the message is about.
   */
  const [loadError, setLoadError] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async (slug: BusinessSlug) => {
    setLoading(true);
    setError("");
    setLoadError("");
    try {
      const data = await getForecast(slug);
      setStatus(data.status);
      setUpcoming(data.upcoming);
      setAccuracy(data.accuracy);
      setRecent(data.recent);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the forecast.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setNote("");
    void load(business);
  }, [business, load]);

  async function handleRefresh() {
    setBusy(true);
    setError("");
    setNote("");
    try {
      const result = await refreshForecast(business);
      // The blocked count is reported rather than swallowed. "Looked at both
      // metrics and wrote nothing, here is why" is a result; a silent no-op
      // after pressing a button reads as a failure.
      setNote(
        result.written === 0
          ? `Marked ${result.scored} past ${result.scored === 1 ? "day" : "days"}. Nothing forecast — ${result.blocked} ${result.blocked === 1 ? "measure does" : "measures do"} not have enough history yet, and the reason is under each heading below.`
          : `Marked ${result.scored} past ${result.scored === 1 ? "day" : "days"} and wrote ${result.written} forecasts.`
      );
      await load(business);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not recompute.");
    } finally {
      setBusy(false);
    }
  }

  const metrics = status?.metrics ?? [];
  const anyForecastable = metrics.some((metric) => metric.blockedBecause === null);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">
        <header className="act-head">
          <h1>What&rsquo;s coming</h1>
        </header>
        <p className="act-lede">
          Projected demand for the next {status?.horizonDays ?? 7} days, and — more to the point —
          how the last projections actually turned out. Nothing is shown here until the method has
          been marked against this business&rsquo;s own history, and every figure sits next to what
          guessing &ldquo;the same weekday last week&rdquo; would have said.
        </p>

        <div className="act-tabs">
          {TENANTS.map((tenant) => (
            <button
              key={tenant.slug}
              aria-pressed={business === tenant.slug}
              onClick={() => setBusiness(tenant.slug as BusinessSlug)}
            >
              {tenant.ref}
            </button>
          ))}
        </div>

        {loadError ? (
          /*
           * WHEN THE LOAD FAILS, NOTHING BELOW IS DRAWN.
           *
           * This line used to appear ABOVE the data, and the data was
           * whatever the last successful load had put in state. Switch
           * business, have the request fail, and this page showed the
           * PREVIOUS business's numbers under the new one's name — one
           * tenant's figures attributed to another, arriving through the
           * UI rather than the database that spent a whole feature
           * preventing exactly that.
           *
           * Clearing the data instead would have been worse: the page
           * would fall through to its empty state and say "nothing to
           * report" when the truth is "nobody could ask". Those are the
           * two silences the operators panel was fixed for this morning.
           */
          <p className="act-msg">{loadError}</p>
        ) : null}

        <div className="fc-run">
          <button className="fc-btn" onClick={handleRefresh} disabled={busy || loading}>
            {busy ? "Working…" : "Score and re-forecast"}
          </button>
          <p className="fc-run-note">
            {status?.lastCompleteDay
              ? `History runs to ${status.lastCompleteDay}, the last day that has finished where this business is. Today is deliberately excluded — a few hours of traffic reads as a collapse in volume.`
              : "No completed day of history yet."}
          </p>
        </div>
        {note ? <p className="fc-note">{note}</p> : null}

        {loadError ? null : loading ? (
          <div className="act-empty">Loading…</div>
        ) : (
          <>
            {metrics.map((metric) => (
              <MetricSection
                key={metric.metric}
                readiness={metric}
                upcoming={upcoming.filter((row) => row.metric === metric.metric)}
                accuracy={accuracy.filter((row) => row.metric === metric.metric)}
              />
            ))}

            {recent.length > 0 ? <RecentTable rows={recent} /> : null}

            <p className="fc-caveat">
              {anyForecastable ? (
                <>
                  These are projections from weekday patterns in past volume, and nothing more. They
                  know nothing about a campaign you are about to run, a public holiday, or a
                  competitor closing. Treat the interval as the honest part of the figure and the
                  midpoint as the convenient one.
                </>
              ) : (
                <>
                  Nothing is being projected for this business yet, and that is the designed
                  behaviour rather than a fault. A forecast drawn from too little history is not a
                  weaker forecast — it is a confident number with nothing underneath it, and it
                  would be indistinguishable on this page from a good one.
                </>
              )}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/** One measure: its refusal, or its forecast, its backtest and its scored accuracy. */
function MetricSection({
  readiness,
  upcoming,
  accuracy,
}: {
  readiness: MetricReadiness;
  upcoming: StoredForecast[];
  accuracy: ForecastAccuracy[];
}) {
  const blocked = readiness.blockedBecause !== null;
  const publishable = accuracy.filter((row) => row.publishable);

  return (
    <section className="fc-metric">
      <div className="fc-metric-head">
        <h2>{readiness.label}</h2>
        <span className="fc-evidence">
          {readiness.historyDays} complete days · {readiness.activeDays} with traffic
        </span>
      </div>

      {blocked ? (
        // The refusal gets the space the chart would have had, and says which
        // constraint binds — so the reader knows whether to wait or to fix
        // something. An empty panel would read as broken.
        <div className="fc-blocked">
          <strong>Not forecasting this yet.</strong>
          <p>{readiness.blockedBecause}</p>
        </div>
      ) : (
        <>
          {readiness.backtest ? (
            <div className={`fc-backtest ${readiness.backtest.beatsBaseline ? "" : "warn"}`}>
              {readiness.backtest.beatsBaseline ? (
                <p>
                  Tested against the last {readiness.backtest.days} days of this business&rsquo;s own
                  history, predicting each one using only the days before it, this method was out by{" "}
                  <b>{readiness.backtest.methodMae.toFixed(1)}</b> on average. Guessing the same
                  weekday a week earlier was out by {readiness.backtest.baselineMae.toFixed(1)}.
                </p>
              ) : (
                // Published in the same type as a win. A method that loses to
                // the naive baseline and says nothing is the failure this whole
                // feature is built to avoid.
                <p>
                  <b>This method is not beating a naive guess here.</b> Over the last{" "}
                  {readiness.backtest.days} days it was out by{" "}
                  {readiness.backtest.methodMae.toFixed(1)} on average, against{" "}
                  {readiness.backtest.baselineMae.toFixed(1)} for simply repeating the same weekday a
                  week earlier. Read the numbers below as that repetition, not as insight.
                </p>
              )}
            </div>
          ) : null}

          {upcoming.length === 0 ? (
            <div className="fc-blocked">
              <strong>Nothing stored for the days ahead.</strong>
              <p>
                This measure can be forecast, but no run has written one yet. Press &ldquo;Score and
                re-forecast&rdquo;.
              </p>
            </div>
          ) : (
            <ForecastBars rows={upcoming} />
          )}

          <div className="fc-accuracy">
            <h3>How these have actually done</h3>
            {publishable.length === 0 ? (
              <p className="fc-unchecked">
                Not checked yet. Accuracy here counts only forecasts written down <i>before</i> the
                day they describe, and enough of those have to close first
                {accuracy.length > 0
                  ? ` — ${accuracy.reduce((sum, row) => sum + row.scored, 0)} scored so far.`
                  : "."}{" "}
                The backtest above is the method marking its own homework; this is the number that
                cannot be argued with, and it has to be earned a day at a time.
              </p>
            ) : (
              <table className="fc-acc-table">
                <thead>
                  <tr>
                    <th>Made</th>
                    <th>Scored</th>
                    <th>Off by</th>
                    <th>Naive guess off by</th>
                    <th>Inside the range</th>
                  </tr>
                </thead>
                <tbody>
                  {publishable.map((row) => (
                    <tr key={row.horizonDays}>
                      <td>
                        {row.horizonDays} day{row.horizonDays === 1 ? "" : "s"} ahead
                      </td>
                      <td>{row.scored}</td>
                      <td className={row.beatsBaseline ? "fc-good" : "fc-warn"}>
                        {row.methodMae.toFixed(1)}
                      </td>
                      <td>{row.baselineMae.toFixed(1)}</td>
                      <td>{Math.round(row.insideInterval * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The next seven days.
 *
 * The interval is drawn as the bar and the midpoint as a line inside it, rather
 * than the other way round. A tall bar at the predicted value with thin whiskers
 * invites the eye to read the midpoint as the answer; here the width of the
 * uncertainty is the thing that is hard to ignore, which on this much history is
 * the correct emphasis.
 */
function ForecastBars({ rows }: { rows: StoredForecast[] }) {
  const peak = Math.max(1, ...rows.map((row) => row.intervalHigh));

  return (
    <div className="fc-bars">
      {rows.map((row) => {
        const low = (row.intervalLow / peak) * 100;
        const high = (row.intervalHigh / peak) * 100;
        const mid = (row.predicted / peak) * 100;
        return (
          <div className="fc-bar" key={`${row.targetDay}-${row.horizonDays}`}>
            <div className="fc-bar-track">
              <div
                className="fc-bar-range"
                style={{ bottom: `${low}%`, height: `${Math.max(high - low, 1.5)}%` }}
              />
              <div className="fc-bar-mid" style={{ bottom: `${mid}%` }} />
            </div>
            <div className="fc-bar-value">{formatCount(row.predicted)}</div>
            <div className="fc-bar-range-label">
              {formatCount(row.intervalLow)}&ndash;{formatCount(row.intervalHigh)}
            </div>
            <div className="fc-bar-day">{weekdayLabel(row.targetDay)}</div>
            <div className="fc-bar-date">{row.targetDay.slice(5)}</div>
          </div>
        );
      })}
    </div>
  );
}

/** Predicted against happened, most recent first. */
function RecentTable({ rows }: { rows: ScoredForecast[] }) {
  return (
    <section className="fc-metric">
      <div className="fc-metric-head">
        <h2>Recently marked</h2>
        <span className="fc-evidence">what was said, and what happened</span>
      </div>
      <p className="fc-sub">
        An average error is abstract. &ldquo;We said 9, it was 3&rdquo; is the thing that tells you
        whether to trust next week&rsquo;s number.
      </p>
      <div className="act-table">
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Measure</th>
              <th>Made</th>
              <th>Said</th>
              <th>Happened</th>
              <th>Off by</th>
              <th>Naive off by</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.metric}-${row.targetDay}-${row.horizonDays}`}>
                <td>
                  {weekdayLabel(row.targetDay)} {row.targetDay.slice(5)}
                </td>
                <td>{row.metric === "conversations" ? "Conversations" : "Needed a person"}</td>
                <td className="act-sub">{row.horizonDays}d ahead</td>
                <td>{formatCount(row.predicted)}</td>
                <td>
                  <b>{row.actual}</b>
                </td>
                <td className={row.error <= row.baselineError ? "fc-good" : "fc-warn"}>
                  {formatCount(row.error)}
                </td>
                <td className="act-zero">{formatCount(row.baselineError)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Whole numbers where they are whole. "7.00 conversations" is false precision. */
function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function weekdayLabel(day: string): string {
  // UTC, matching how the forecasting code reads the same date strings. Parsed
  // locally, a browser west of Greenwich shifts every label back a day.
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  });
}
