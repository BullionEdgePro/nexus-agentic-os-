import { NumberTile } from "../../kit/number-tile";
import { ChartCard } from "../../kit/chart-card";
import { AreaChart, BarChart } from "../../kit/charts";
import type { WorkflowAudit } from "@nexus/shared";
import { formatWait } from "@/lib/kit/wait-band";
import { channelName } from "@/lib/workflow/step-figures";
import { Funnel } from "./funnel";

/**
 * The audit's tiles and charts (2 Nov 2026, SFS workflow audit): six figures
 * and five charts for the chosen period, in the business's own days — days
 * for 7 and 30, Monday weeks for 90. The bucket holding today is drawn in
 * progress; a day with no reply to time is an empty slot, never a zero.
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §5
 */

const DAY_MS = 86_400_000;
const toMs = (day: string) => Date.parse(`${day}T00:00:00Z`);
const n = (value: number) => value.toLocaleString("en-GB");

/** "1 Nov" for a day, "w/c 26 Oct" for a week. */
export function bucketLabel(bucket: string, kind: "day" | "week"): string {
  const date = new Date(toMs(bucket)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  return kind === "week" ? `w/c ${date}` : date;
}

/** Whether a bucket is the one still in progress: it holds today. */
export function holdsToday(bucket: string, today: string, kind: "day" | "week"): boolean {
  const start = toMs(bucket);
  const t = toMs(today);
  return t >= start && t < start + (kind === "week" ? 7 : 1) * DAY_MS;
}

export function AuditTiles({ audit }: { audit: WorkflowAudit }) {
  const e = audit.evidence;
  const period = `In the last ${audit.period.days} days`;
  const median = e.replies.medianMs;
  return (
    <section className="kit-tiles wf-tiles" aria-label="The period in figures">
      <NumberTile label="New leads" value={n(e.leads.total)} note={period} />
      <NumberTile
        label="Median first reply"
        value={median === null ? "—" : formatWait(median)}
        note={median === null ? "No reply to a new lead yet" : `${period}, to new leads`}
      />
      <NumberTile label="Hot leads" value={n(e.qualifier.hot)} note={`${period}, scored high or urgent`} />
      <NumberTile label="Viewings held" value={n(e.viewings.held)} note={period} />
      <NumberTile
        label="Follow-ups overdue now"
        value={n(e.followUps.overdueNow)}
        note={`${n(e.followUps.openNow)} open now`}
        edge={e.followUps.overdueNow > 0 ? "terra" : undefined}
      />
      <NumberTile label="Won (labelled)" value={n(e.won)} note={`${period}; rent or sale isn't recorded`} />
    </section>
  );
}

/** Names with a bar and a count each — channels, lead sources — that never widen their row. */
function Shares({ title, rows }: { title: string; rows: { name: string; count: number }[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <div className="wf-shares">
      <h4>{title}</h4>
      <ul>
        {rows.map((r) => (
          <li key={r.name} className="wf-share">
            <span className="wf-source" dir="auto" title={r.name}>
              {r.name}
            </span>
            <span className="kit-hbar" aria-hidden="true">
              <i style={{ width: `${((r.count / max) * 100).toFixed(1)}%` }} />
            </span>
            <b>{n(r.count)}</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AuditCharts({ audit }: { audit: WorkflowAudit }) {
  const { evidence: e, series, period, business } = audit;
  const kind = period.bucket;
  const per = kind === "week" ? "week" : "day";
  const label = (bucket: string) => bucketLabel(bucket, kind);
  const partial = (bucket: string) => holdsToday(bucket, period.today, kind);
  const median = e.replies.medianMs;

  return (
    <div className="wf-charts">
      <ChartCard title="Leads coming in" figure={n(e.leads.total)} note={`New leads per ${per}; today counts so far.`}>
        <AreaChart
          points={series.leads.map((r) => ({ label: partial(r.bucket) ? `${label(r.bucket)} (so far)` : label(r.bucket), value: r.count }))}
          ariaLabel={`New leads per ${per}`}
        />
        <Shares
          title="By channel"
          rows={Object.entries(e.leads.byChannel)
            .sort((a, b) => b[1] - a[1])
            .map(([channel, count]) => ({ name: channelName(channel), count }))}
        />
        <Shares title="By lead source, where one was recorded" rows={e.leads.bySource.map((s) => ({ name: s.source, count: s.count }))} />
      </ChartCard>

      <ChartCard
        title={`How fast ${business.name} answers`}
        figure={median === null ? "—" : formatWait(median)}
        note={`Median first reply to a new lead, per ${per}.`}
      >
        <BarChart
          bars={series.replyMedian.map((r) => ({ label: label(r.bucket), value: r.medianMs, partial: partial(r.bucket) }))}
          ariaLabel={`Median first reply per ${per}`}
          format={formatWait}
          emptyLabel="no replies"
        />
        <dl className="kit-rows wf-rows">
          <dt>First reply by AI</dt>
          <dd>{n(e.replies.byAi)}</dd>
          <dt>By a person</dt>
          <dd>{n(e.replies.byPerson)}</dd>
          <dt>Not answered yet</dt>
          <dd>{n(e.replies.unanswered)}</dd>
        </dl>
      </ChartCard>

      <ChartCard
        title="From lead to won"
        note="The period's new leads, followed: each step counts those who reached every step before it, and each share is of the step before."
      >
        <Funnel funnel={audit.funnel} />
      </ChartCard>

      <ChartCard
        title="Viewings"
        figure={n(e.viewings.booked)}
        note={`Booked per ${per}, held shaded. ${n(e.viewings.noShow)} no-show, ${n(e.viewings.cancelled)} cancelled.`}
      >
        <BarChart
          bars={series.viewings.map((r) => ({
            label: label(r.bucket),
            value: r.booked,
            part: r.held,
            partial: partial(r.bucket),
            note: `${n(r.noShow)} no-show, ${n(r.cancelled)} cancelled`,
          }))}
          ariaLabel={`Viewings booked per ${per}`}
          partLabel="held"
        />
      </ChartCard>

      <ChartCard
        title="Lead quality"
        figure={n(e.qualifier.scored)}
        note={`People scored per ${per}, hot shaded. ${n(e.leads.pitches)} sales pitches filtered out.`}
      >
        <BarChart
          bars={series.quality.map((r) => ({ label: label(r.bucket), value: r.scored, part: r.hot, partial: partial(r.bucket) }))}
          ariaLabel={`Leads scored per ${per}`}
          partLabel="hot"
        />
      </ChartCard>
    </div>
  );
}
