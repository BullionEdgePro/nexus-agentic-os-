"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { getResponseTimes, readableError, type StaffResponseTime } from "@/lib/api";

/**
 * How fast each person answers a waiting customer — DoubleTick's team
 * performance report, in the same honest terms as the table above it.
 *
 * Its own load and its own failure: a response-time query that fails must not
 * blank the roster, and the roster failing must not take this with it.
 */
export function ResponseTimes({ business }: { business: BusinessSlug | "" }) {
  const [days, setDays] = useState<7 | 30 | 90>(30);
  const [rows, setRows] = useState<StaffResponseTime[] | null>(null);
  const [target, setTarget] = useState(180);
  const [failed, setFailed] = useState("");

  const load = useCallback(async (slug: BusinessSlug | "", period: 7 | 30 | 90) => {
    setRows(null);
    setFailed("");
    try {
      const data = await getResponseTimes(period, slug || undefined);
      setRows(data.staff);
      setTarget(data.targetMinutes);
    } catch (err) {
      setFailed(readableError(err, "Could not read response times."));
    }
  }, []);

  useEffect(() => {
    void load(business, days);
  }, [business, days, load]);

  const fastest = rows
    ?.filter((r) => r.medianSeconds != null && r.responses >= 3)
    .sort((a, b) => (a.medianSeconds ?? 0) - (b.medianSeconds ?? 0))[0];

  return (
    <section className="rt">
      <header className="rt-head">
        <h2 className="act-sub-head">Response times</h2>
        <div className="rt-periods" role="tablist" aria-label="Period">
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={days === d}
              className={`rt-period${days === d ? " on" : ""}`}
              onClick={() => setDays(d)}
            >
              {d} days
            </button>
          ))}
        </div>
      </header>
      <p className="rt-lede">
        How long a customer waited for a person&apos;s reply — timed from the message it answered. Replies after
        the AI had already answered are counted as sent, not as a wait. Target:{" "}
        <b>{formatDuration(target * 60)}</b>.
      </p>

      {failed ? (
        <p className="act-msg">{failed}</p>
      ) : rows === null ? (
        <div className="act-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="act-empty">No replies from a person in the last {days} days.</div>
      ) : (
        <>
          {fastest ? (
            <p className="rt-star">
              ⚡ Fastest this period: <b>{fastest.name}</b>, typically replying in{" "}
              <b>{formatDuration(fastest.medianSeconds ?? 0)}</b>.
            </p>
          ) : null}
          <div className="rt-grid">
            {rows.map((r) => {
              const pct = r.responses ? Math.round((r.withinTarget / r.responses) * 100) : null;
              return (
                <article key={r.staffId ?? "unattributed"} className={`rt-card${r.staffId ? "" : " muted"}`}>
                  <header>
                    <span className="rt-av" aria-hidden="true">
                      {r.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="rt-who">
                      <b>{r.name}</b>
                      <small>{r.organizationName ?? (r.staffId ? "Administrator" : "Before replies carried a name")}</small>
                    </span>
                  </header>
                  <dl>
                    <div>
                      <dt>Typical reply</dt>
                      <dd>{r.medianSeconds == null ? "—" : formatDuration(r.medianSeconds)}</dd>
                    </div>
                    <div>
                      <dt>Average</dt>
                      <dd>{r.averageSeconds == null ? "—" : formatDuration(r.averageSeconds)}</dd>
                    </div>
                    <div>
                      <dt>Slowest</dt>
                      <dd>{r.slowestSeconds == null ? "—" : formatDuration(r.slowestSeconds)}</dd>
                    </div>
                    <div>
                      <dt>Replies</dt>
                      <dd>
                        {r.repliesSent}
                        <small> · {r.responses} to a wait</small>
                      </dd>
                    </div>
                  </dl>
                  {pct != null ? (
                    <div className="rt-bar" title={`${r.withinTarget} of ${r.responses} within target`}>
                      <span className={pct >= 80 ? "good" : pct >= 50 ? "ok" : "bad"} style={{ width: `${pct}%` }} />
                      <em>{pct}% within target</em>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** "42s", "7 min", "2 h 05 m", "3 d 4 h" — a wait as a person says it. */
function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h} h ${String(Math.round((s % 3600) / 60)).padStart(2, "0")} m`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
