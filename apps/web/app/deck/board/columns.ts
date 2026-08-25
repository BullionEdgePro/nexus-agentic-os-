/**
 * Which column a follow-up belongs in, and what a card takes when it lands.
 *
 * Its own module, with no JSX in it, so the rules can be tested without a
 * browser or a render. They are the only part of the board that can be WRONG
 * rather than merely ugly: a card in the wrong column is a promise reported at
 * the wrong urgency, and a wrong date on a drop is a commitment moved to a time
 * nobody chose.
 */
import type { TaskRecord } from "../../../lib/api";

export type ColumnKey = "overdue" | "today" | "later" | "done";

export const COLUMNS: Array<{ key: ColumnKey; label: string; hint: string }> = [
  { key: "overdue", label: "Overdue", hint: "promised for a time that has passed" },
  { key: "today", label: "Today", hint: "due before midnight" },
  { key: "later", label: "Later", hint: "due another day, or no date yet" },
  { key: "done", label: "Done", hint: "closed, with who closed it" },
];


function endOfToday(): number {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/**
 * Which column a follow-up belongs in.
 *
 * Cancelled sits with done rather than getting a column of its own: both mean
 * "not going to happen", the board's job is what is still owed, and a fifth
 * column that is empty on almost every business is furniture.
 */
export function columnFor(task: TaskRecord): ColumnKey {
  if (task.status !== "open") return "done";

  // OVERDUE IS THE SERVER'S ANSWER, NOT THIS BROWSER'S. `isOverdue` is computed
  // by the database clock and its own field says so: "do not recompute from
  // dueAt in the browser". A laptop an hour out of step would otherwise draw a
  // card in Overdue that the API, the list screen and the overdue-followup
  // operator all consider fine — three surfaces disagreeing about one promise.
  if (task.isOverdue) return "overdue";
  if (!task.dueAt) return "later";

  // Today vs Later IS a local question, and correctly so: "before midnight"
  // means before midnight where the person reading the board is.
  const due = new Date(task.dueAt).getTime();
  if (Number.isNaN(due)) return "later";
  return due <= endOfToday() ? "today" : "later";
}

/** The date a card should take when dropped into a column. */
export function dueDateFor(column: ColumnKey): string | null {
  const d = new Date();
  if (column === "overdue") {
    // Deliberately an hour ago rather than "now". Dropping something INTO
    // overdue is a person saying it is already late; landing it exactly on the
    // boundary would let a slow render put it back in Today.
    d.setHours(d.getHours() - 1);
    return d.toISOString();
  }
  if (column === "today") {
    d.setHours(17, 0, 0, 0);
    // Late afternoon, unless that has passed — in which case the end of the
    // day, because a card dropped in Today must not immediately read Overdue.
    if (d.getTime() < Date.now()) d.setHours(23, 30, 0, 0);
    return d.toISOString();
  }
  if (column === "later") {
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  }
  return null;
}

