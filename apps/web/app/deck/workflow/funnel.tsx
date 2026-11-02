import { share, type WorkflowAudit } from "@nexus/shared";

/**
 * From lead to won (2 Nov 2026, SFS workflow audit): one cohort — the
 * period's new leads — followed step by step. Each step shows its count and
 * its share of the step before: "3 of 7" while that step is under 20 people,
 * a percentage from 20 up. Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §5
 */
const STEPS: { key: keyof WorkflowAudit["funnel"]; label: string }[] = [
  { key: "leads", label: "New leads" },
  { key: "scored", label: "Scored" },
  { key: "hot", label: "Hot" },
  { key: "booked", label: "Viewing booked" },
  { key: "held", label: "Viewing held" },
  { key: "won", label: "Won (labelled)" },
];

export function Funnel({ funnel }: { funnel: WorkflowAudit["funnel"] }) {
  const base = funnel.leads;
  return (
    <ol className="wf-funnel">
      {STEPS.map((step, i) => {
        const count = funnel[step.key];
        const before = i > 0 ? funnel[STEPS[i - 1]!.key] : null;
        // The bar is the step's part of the whole cohort; one decimal, so it never reads as the share.
        const width = base > 0 ? `${((count / base) * 100).toFixed(1)}%` : "0%";
        return (
          <li key={step.key} className="wf-funnel-step">
            <span className="wf-funnel-name">{step.label}</span>
            <b className="wf-funnel-count">{count.toLocaleString("en-GB")}</b>
            <span className="wf-funnel-share">{before === null ? "" : share(count, before)}</span>
            <span className="kit-hbar" aria-hidden="true">
              <i style={{ width }} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}
