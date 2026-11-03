import { useId } from "react";
import { boardColumns, moveProblem, nextSteps, type BoardCard, type Workflow, type WorkflowStep } from "@nexus/shared";

/**
 * Move to… (3 Nov 2026, the workflow board): the way to move a card that works
 * for everyone — by keyboard, with a screen reader, on a phone where a drag is
 * awkward. The drawing's own next steps come first; every other step of the
 * lane follows. A step the rules shut is shown, disabled, with the reason.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §2
 */
export function MoveMenu({
  workflow,
  card,
  today,
  onMove,
}: {
  workflow: Workflow;
  card: BoardCard;
  today: string;
  onMove: (to: string) => void;
}) {
  const heading = useId();
  const columns = boardColumns(workflow, card.kind === "unit" ? "supply" : "demand").filter((s) => s.id !== card.step);
  const next = nextSteps(workflow, card.step)
    .map((id) => columns.find((s) => s.id === id))
    .filter((s): s is WorkflowStep => Boolean(s));
  const rest = columns.filter((s) => !next.includes(s));

  const option = (step: WorkflowStep) => {
    const problem = moveProblem(card, step.id, today);
    return (
      <button key={step.id} type="button" className="kit-pill" disabled={problem !== null} title={problem ?? undefined} onClick={() => onMove(step.id)}>
        {step.name}
      </button>
    );
  };

  return (
    <div className="wf-board-move" role="group" aria-labelledby={heading}>
      <h4 id={heading} className="wf-h3">
        Move to…
      </h4>
      {next.length > 0 ? (
        <>
          <p className="wf-board-move-label">Next:</p>
          <div className="wf-board-move-row">{next.map(option)}</div>
        </>
      ) : null}
      {rest.length > 0 ? (
        <>
          <p className="wf-board-move-label">Another step</p>
          <div className="wf-board-move-row">{rest.map(option)}</div>
        </>
      ) : null}
    </div>
  );
}
