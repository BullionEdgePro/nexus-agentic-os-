import type { StepStatus, Workflow, WorkflowAudit } from "@nexus/shared";
import { laneProgress, leadTrend, whereStuck } from "@/lib/workflow/pulse";

/**
 * The Pulse (3 Nov 2026, the SFS workflow tab): before the lanes, the three
 * things a person checks first -- how much of each lane is working, where work
 * is stuck, and how leads moved over the period. Drawn only from the audit.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-tab-design.md §3
 */

const STATUS_WORD: Record<StepStatus, string> = {
  working: "working",
  idle: "idle",
  partly: "partly built",
  not_tracked: "not tracked in Nexus yet",
};

const n = (value: number) => value.toLocaleString("en-GB");

function bucketLabel(bucket: string, unit: "day" | "week"): string {
  const date = new Date(`${bucket}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return bucket;
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return unit === "week" ? `week of ${day}` : day;
}

/** The period's leads as a line; flat when there were none, never divided by zero. */
function Spark({ points }: { points: number[] }) {
  const width = 160;
  const height = 40;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? width / (points.length - 1) : 0;
  const xy = points.map((value, i) => [points.length > 1 ? i * step : width / 2, height - 4 - (value / max) * (height - 8)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return (
    <svg className="wf-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {xy.length > 1 ? <polyline points={line} /> : null}
      {xy.length === 1 ? <circle cx={xy[0][0]} cy={xy[0][1]} r={3} /> : null}
    </svg>
  );
}

export function WorkflowPulse({ workflow, audit }: { workflow: Workflow; audit: WorkflowAudit }) {
  const lanes = laneProgress(workflow, audit.evidence);
  const stuck = whereStuck(workflow, audit);
  const trend = leadTrend(audit.series, audit.period.bucket);

  return (
    <section className="wf-section wf-vitals" aria-labelledby="wf-h-pulse">
      <h2 id="wf-h-pulse" className="wf-h2">
        Pulse
      </h2>
      <div className="wf-vitals-grid">
        <div className="wf-vitals-card">
          <h3 className="wf-h3">Progress</h3>
          {lanes.map((lane) => (
            <div key={lane.lane} className="wf-progress" data-lane={lane.lane}>
              <div className="wf-progress-head">
                <span>{lane.label}</span>
                <span className="wf-progress-count">
                  {lane.working} of {lane.total} working
                </span>
              </div>
              <div className="wf-progress-bar" role="img" aria-label={`${lane.label}: ${lane.working} of ${lane.total} steps working`}>
                {lane.steps.map((s) => (
                  <span key={s.id} className={`wf-seg wf-seg-${s.status}`} title={`${s.name} — ${STATUS_WORD[s.status]}`} />
                ))}
              </div>
            </div>
          ))}
          <ul className="wf-legend" aria-label="Key">
            {(["working", "idle", "partly", "not_tracked"] as const).map((status) => (
              <li key={status}>
                <span className={`wf-key wf-seg-${status}`} aria-hidden="true" />
                {STATUS_WORD[status]}
              </li>
            ))}
          </ul>
        </div>

        <div className="wf-vitals-card">
          <h3 className="wf-h3">Where it&rsquo;s stuck</h3>
          <ul className="wf-stuck">
            {stuck.map((item) => (
              <li key={item.kind} className={`wf-stuck-${item.kind}`}>
                <strong>{item.href ? <a href={item.href}>{item.title}</a> : item.title}</strong>
                {item.detail ? <span>{item.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>

        <div className="wf-vitals-card wf-trend">
          <h3 className="wf-h3">Leads</h3>
          <p className="wf-trend-total">{n(trend.total)}</p>
          <Spark points={trend.points} />
          <p className="wf-trend-note">
            {trend.peak
              ? `Busiest ${trend.unit}: ${bucketLabel(trend.peak.bucket, trend.unit)} · ${n(trend.peak.count)}`
              : `No leads in the last ${audit.period.days} days`}
          </p>
        </div>
      </div>
    </section>
  );
}
