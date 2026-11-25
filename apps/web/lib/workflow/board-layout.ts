import type { Board, BoardCard, Lane, WorkflowStep } from "@nexus/shared";

/**
 * The compact board's layout rules (25 Nov 2026), kept pure so they can be
 * tested: which steps hold cards (shown full, first) and which are empty
 * (folded into a row of chips), how many hot leads show before "Show all".
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §3
 */

/**
 * The viewer's own card (§3.8): they are its agent. A viewer with no employee
 * record (an admin, or "View as staff") owns nothing.
 */
export function isMine(card: BoardCard, viewer: Board["viewer"] | undefined): boolean {
  return !!viewer?.employeeId && card.agent?.id === viewer.employeeId;
}

/**
 * A staff member the board names (§3.8): not an admin. A board from an API
 * older than 25 Nov 2026 names nobody; then nothing on screen is anyone's own
 * (no "Only mine", no My board) instead of the screen breaking.
 */
export function isStaffViewer(viewer: Board["viewer"] | undefined): boolean {
  return !!viewer && !viewer.seesAll;
}

/** Whether the board offers "Only mine": to staff with an employee record, the only viewers who own cards. */
export function offersOnlyMine(viewer: Board["viewer"] | undefined): boolean {
  return isStaffViewer(viewer) && !!viewer?.employeeId;
}

/**
 * The lane of the card being dragged, or null when none is (final review,
 * 25 Nov 2026): only that lane's empty steps open up. A card never drops in the
 * other lane, and a deal in hand must not push the deals down under the units'
 * opened steps.
 */
export function draggedLane(cards: BoardCard[], dragging: string | null): Lane | null {
  const card = dragging ? cards.find((c) => c.id === dragging) : undefined;
  return card ? (card.kind === "unit" ? "supply" : "demand") : null;
}

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
