import { stepStatus, type Lane, type StepStatus, type Workflow, type WorkflowAudit } from "@nexus/shared";

/**
 * The workflow's Pulse (3 Nov 2026, the SFS workflow tab): progress per lane,
 * where it is stuck, and the lead trend -- every figure read from the audit the
 * page already holds. Nothing is estimated, and nothing is compared with a period
 * the page did not ask for.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-tab-design.md §3
 */

export type LaneProgress = {
  lane: Lane;
  label: string;
  steps: { id: string; name: string; status: StepStatus }[];
  working: number;
  total: number;
};

const LANE_LABEL: Record<Lane, string> = { supply: "Supply", demand: "Demand" };

export function laneProgress(workflow: Workflow, evidence: WorkflowAudit["evidence"]): LaneProgress[] {
  return (["supply", "demand"] as const).map((lane) => {
    const steps = workflow.steps
      .filter((step) => step.lane === lane)
      .map((step) => ({ id: step.id, name: step.name, status: stepStatus(step, evidence) }));
    return { lane, label: LANE_LABEL[lane], steps, working: steps.filter((s) => s.status === "working").length, total: steps.length };
  });
}

export type StuckItem = {
  kind: "drop" | "idle" | "unanswered" | "overdue" | "clear";
  title: string;
  detail: string;
  href: string | null;
};

const FUNNEL: { key: keyof WorkflowAudit["funnel"]; label: string }[] = [
  { key: "leads", label: "leads" },
  { key: "scored", label: "scored" },
  { key: "hot", label: "hot" },
  { key: "booked", label: "viewings booked" },
  { key: "held", label: "viewings held" },
  { key: "won", label: "won" },
];

const n = (value: number) => value.toLocaleString("en-GB");

/** The steepest fall between consecutive funnel stages, by the share lost; a stage of zero starts none. */
function steepestDrop(funnel: WorkflowAudit["funnel"]): StuckItem | null {
  let best: { from: (typeof FUNNEL)[number]; to: (typeof FUNNEL)[number]; lost: number } | null = null;
  for (let i = 0; i + 1 < FUNNEL.length; i++) {
    const from = FUNNEL[i];
    const to = FUNNEL[i + 1];
    const a = funnel[from.key];
    const b = funnel[to.key];
    if (a <= 0 || b >= a) continue;
    const lost = (a - b) / a;
    if (!best || lost > best.lost) best = { from, to, lost };
  }
  if (!best) return null;
  return {
    kind: "drop",
    title: `Biggest drop: ${best.from.label} to ${best.to.label}`,
    detail: `${n(funnel[best.from.key])} → ${n(funnel[best.to.key])}`,
    href: null,
  };
}

export function whereStuck(workflow: Workflow, audit: WorkflowAudit): StuckItem[] {
  const items: StuckItem[] = [];
  const drop = steepestDrop(audit.funnel);
  if (drop) items.push(drop);

  const idle = workflow.steps.filter((step) => stepStatus(step, audit.evidence) === "idle").map((step) => step.name);
  if (idle.length > 0) {
    items.push({
      kind: "idle",
      title: idle.length === 1 ? "A built step sat idle" : "Built steps that sat idle",
      detail: idle.join(", "),
      href: null,
    });
  }

  const { unanswered } = audit.evidence.replies;
  if (unanswered > 0) {
    items.push({ kind: "unanswered", title: "Chats waiting for a reply", detail: `${n(unanswered)} waiting now`, href: "/inbox" });
  }

  const { overdueNow } = audit.evidence.followUps;
  if (overdueNow > 0) {
    items.push({ kind: "overdue", title: "Follow-ups past due", detail: `${n(overdueNow)} past due now`, href: "/deck/tasks" });
  }

  if (items.length === 0) {
    return [{ kind: "clear", title: `Nothing is stuck in the last ${audit.period.days} days`, detail: "", href: null }];
  }
  return items;
}

export type LeadTrend = {
  total: number;
  peak: { bucket: string; count: number } | null;
  points: number[];
  unit: "day" | "week";
};

/** The period's leads as a line: its total, its busiest bucket (none when every bucket is zero), its points. */
export function leadTrend(series: WorkflowAudit["series"], unit: "day" | "week"): LeadTrend {
  const points = series.leads.map((b) => b.count);
  const total = points.reduce((sum, count) => sum + count, 0);
  let peak: LeadTrend["peak"] = null;
  for (const b of series.leads) if (b.count > 0 && (!peak || b.count > peak.count)) peak = { bucket: b.bucket, count: b.count };
  return { total, peak, points, unit };
}

/** Nothing at all recorded in the period: every count in the evidence and the funnel is zero. */
export function isQuiet(audit: WorkflowAudit): boolean {
  const anyAboveZero = (value: unknown): boolean =>
    typeof value === "number"
      ? value > 0
      : Array.isArray(value)
        ? value.some(anyAboveZero)
        : value !== null && typeof value === "object"
          ? Object.values(value).some(anyAboveZero)
          : false;
  return !anyAboveZero(audit.evidence) && !anyAboveZero(audit.funnel);
}

/** How long ago this browser received the figures -- not a server time. */
export function updatedLabel(fetchedAt: number, now: number): string {
  const ago = Math.max(0, now - fetchedAt);
  if (ago < 60_000) return "Updated just now";
  if (ago < 3_600_000) return `Updated ${Math.floor(ago / 60_000)} min ago`;
  return `Updated ${Math.floor(ago / 3_600_000)} h ago`;
}
