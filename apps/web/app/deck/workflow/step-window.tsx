import { Fragment } from "react";
import { stepStatus, type WorkflowAudit, type WorkflowStep } from "@nexus/shared";
import { CardWindow } from "../../kit/card-window";
import { stepFigures } from "@/lib/workflow/step-figures";
import { STATUS_LOOK, WON_NOTE_UNDER, wonNote } from "./lanes";

/**
 * A workflow step opened into a window (2 Nov 2026, SFS workflow audit): its
 * full evidence for the period, what Nexus does and does not do for it, and
 * the screen that holds the detail — or "No screen yet" where none does.
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §4.3
 */
export function StepWindow({
  step,
  evidence,
  origin,
  onClose,
}: {
  step: WorkflowStep;
  evidence: WorkflowAudit["evidence"];
  origin: HTMLElement | null;
  onClose: () => void;
}) {
  const status = stepStatus(step, evidence);
  const figures = stepFigures(step.id, evidence);
  return (
    <CardWindow open title={`${step.tag} ${step.name}`} onClose={onClose} origin={origin}>
      <div className="wf-window">
        <p className="wf-window-tag">{step.tag}</p>
        <h2 dir="auto">{step.name}</h2>
        <p className="wf-window-sub" dir="auto">
          {step.subtitle}
        </p>
        <span className={`wf-chip wf-chip-${status}`}>{STATUS_LOOK[status].word}</span>
        {figures.length ? (
          <p className="wf-window-caption">Figures are for the chosen period unless they say “in total” or “now”.</p>
        ) : null}
        {figures.length ? (
          <dl className="kit-rows wf-rows">
            {figures.map((f) => (
              <Fragment key={f.label}>
                <dt dir="auto">{f.label}</dt>
                <dd>{f.value}</dd>
              </Fragment>
            ))}
          </dl>
        ) : null}
        {step.does ? (
          <section className="wf-window-part">
            <h3>What Nexus shows</h3>
            <p>{step.does}</p>
          </section>
        ) : null}
        {step.missing ? (
          <section className="wf-window-part">
            <h3>{status === "not_tracked" ? "Tracking it would need" : "Not in Nexus yet"}</h3>
            <p>{step.missing}</p>
          </section>
        ) : null}
        {WON_NOTE_UNDER.includes(step.id) ? <p className="wf-note">{wonNote(evidence.won)}</p> : null}
        <div className="kit-actions">
          {step.link ? (
            <a className="kit-btn" href={step.link.href}>
              Open {step.link.label}
            </a>
          ) : (
            <span className="wf-noscreen">No screen yet</span>
          )}
        </div>
      </div>
    </CardWindow>
  );
}
