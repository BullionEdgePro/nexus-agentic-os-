import type { Evidence, StepStatus, Workflow, WorkflowStep } from "./types.js";

/**
 * A step's status for the period (spec §4.1): a built step is working when
 * something happened and idle when nothing did; partly and not tracked are
 * what Nexus covers, whatever the period holds.
 */
export function stepStatus(step: WorkflowStep, evidence: Evidence): StepStatus {
  if (step.coverage === "partly") return "partly";
  if (step.coverage === "not_tracked") return "not_tracked";
  return step.activity && step.activity(evidence) > 0 ? "working" : "idle";
}

/** How many steps are in each status — the page's one-line verdict. */
export function verdict(workflow: Workflow, evidence: Evidence): Record<StepStatus, number> {
  const out: Record<StepStatus, number> = { working: 0, idle: 0, partly: 0, not_tracked: 0 };
  for (const step of workflow.steps) out[stepStatus(step, evidence)] += 1;
  return out;
}

/**
 * A step's share of the one before it: "3 of 7" while the base is under 20 —
 * a percentage of a handful reads as more certain than it is — and a whole
 * percentage from 20 up. Nothing to share of: "—".
 */
export function share(part: number, whole: number): string {
  if (whole <= 0) return "—";
  if (whole < 20) return `${part} of ${whole}`;
  return `${Math.round((part / whole) * 100)}%`;
}
