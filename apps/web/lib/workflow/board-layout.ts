import type { Board, BoardCard, WorkflowStep } from "@nexus/shared";

/**
 * The compact board's layout rules (25 Nov 2026), kept pure so they can be
 * tested: which steps hold cards (shown full, first) and which are empty
 * (folded into a row of chips), how many hot leads show before "Show all".
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §3
 */

/** Hot leads shown before "Show all (N)". */
export const HOT_SHOWN = 5;

/**
 * The lane's steps split in two, each in workflow order: those holding a card
 * (or a colleague's deal the viewer only sees counted) and the empty ones.
 */
export function splitColumns(
  columns: WorkflowStep[],
  cards: BoardCard[],
  hidden: Board["hidden"]
): { filled: WorkflowStep[]; empty: WorkflowStep[] } {
  const holds = (step: WorkflowStep) =>
    cards.some((c) => c.step === step.id) || (hidden[step.id as keyof Board["hidden"]] ?? 0) > 0;
  return { filled: columns.filter(holds), empty: columns.filter((s) => !holds(s)) };
}
