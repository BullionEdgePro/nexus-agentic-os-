/**
 * F7's board: the column rules, and the two decisions that make it safe.
 *
 * ============================================================
 * WHY A BOARD AT ALL
 * ============================================================
 *
 * F7 said "boards, views and automations are the months, and none is asked for
 * yet". The owner has asked, so the board is built — and the first decision was
 * what the columns are.
 *
 * The obvious kanban is open / done / cancelled, because those are the three
 * values `tasks.status` holds. It would also be useless: two are terminal, so
 * every live commitment lands in one pile and the board says exactly what the
 * list already said.
 *
 * A follow-up is a promise with a time on it. So the columns are WHEN, and
 * dragging a card changes a real field — which is why `rescheduleTask` had to
 * exist at all: until now `due_at` could only be set at creation, and the most
 * ordinary edit anybody makes to a follow-up had no door.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { columnFor, dueDateFor } from "../../web/app/deck/board/columns.ts";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const PAGE = readFileSync(join(root, "apps", "web", "app", "deck", "board", "page.tsx"), "utf8");
const TASKS_DB = readFileSync(join(root, "packages", "db", "src", "tasks.ts"), "utf8");
// The rules live in their own module, with no JSX, so they can be imported and
// run above. The page is still read for the decisions that are about RENDERING
// rather than about which column a card belongs in.
const RULES = readFileSync(join(root, "apps", "web", "app", "deck", "board", "columns.ts"), "utf8");
const rules = withoutComments(RULES);
const code = withoutComments(PAGE);

const task = (over = {}) => ({
  id: "t1",
  status: "open",
  isOverdue: false,
  dueAt: null,
  ...over,
});

test("overdue comes from the server, never from this browser's clock", () => {
  // THE DECISION THAT MATTERS MOST HERE, and it is not mine — TaskRecord's own
  // field says "Decided by the database clock — do not recompute from dueAt in
  // the browser". A laptop an hour out of step would otherwise draw a card in
  // Overdue that the API, the list screen and the overdue-followup operator all
  // consider fine: three surfaces disagreeing about one promise.
  const long_ago = new Date(Date.now() - 86_400_000).toISOString();

  // The same row, the same date, two different answers — decided entirely by
  // what the server said.
  assert.equal(columnFor(task({ dueAt: long_ago, isOverdue: true })), "overdue");

  // And when the server says it is NOT late, the board does not argue. A past
  // date that is not overdue is a contradiction, and it means this browser's
  // clock is ahead of the database. Today is the right bucket for it: it wants
  // attention soonest, and calling it Overdue would be the browser overruling
  // the only clock the rest of the platform agrees on. My first draft of this
  // test expected Later and was simply wrong about which is safer.
  assert.equal(columnFor(task({ dueAt: long_ago, isOverdue: false })), "today");

  assert.ok(
    rules.includes("task.isOverdue"),
    "the board must read the server's verdict rather than comparing dates itself"
  );
});

test("a commitment with no date is Later, not Overdue", () => {
  // The schema allows it and the list shows it. Sorting it into Overdue would
  // invent a deadline nobody set.
  assert.equal(columnFor(task({ dueAt: null })), "later");
});

test("done and cancelled share one column", () => {
  // Both mean "not going to happen". A fifth column that is empty on almost
  // every business is furniture.
  assert.equal(columnFor(task({ status: "done" })), "done");
  assert.equal(columnFor(task({ status: "cancelled" })), "done");
});

test("a card dropped in Today does not immediately read Overdue", () => {
  // The bug this avoids is visible and silly: drag something out of Overdue,
  // watch it land, watch it jump straight back. dueDateFor("today") aims at
  // late afternoon and falls back to the end of the day once that has passed.
  const due = new Date(dueDateFor("today")).getTime();
  assert.ok(due > Date.now(), "a card dropped in Today must be due later than now");
  const midnight = new Date();
  midnight.setHours(23, 59, 59, 999);
  assert.ok(due <= midnight.getTime(), "and must still be due today");
});

test("dropping into Overdue means it, and does not sit on the boundary", () => {
  const due = new Date(dueDateFor("overdue")).getTime();
  assert.ok(due < Date.now(), "a card dropped in Overdue is a person saying it is already late");
});

test("Later is tomorrow, and Done clears the date", () => {
  const due = new Date(dueDateFor("later")).getTime();
  assert.ok(due > Date.now(), "Later must be in the future");
  assert.equal(dueDateFor("done"), null, "completing does not set a due date");
});

test("nothing drags out of Done", () => {
  // Reopening undoes an accountability record — completed_by and all — and is a
  // different decision from rescheduling a live one. It belongs on the list,
  // where it can be explained, not on a drag nobody would remember making.
  assert.ok(
    code.includes('draggable={task.status === "open"}'),
    "closed cards must not be draggable"
  );
});

test("the reschedule writer refuses a closed follow-up", () => {
  // The other half of the same rule, enforced where it cannot be worked around
  // by anything that calls the API directly rather than through the board.
  const at = TASKS_DB.indexOf("export async function rescheduleTask");
  assert.notEqual(at, -1, "rescheduleTask is gone — the board's drag has no writer");
  const fn = TASKS_DB.slice(at, at + 1200);
  assert.ok(
    fn.includes("status = 'open'"),
    "rescheduling must be refused for a closed task: a date on work nobody will do puts a card " +
      "in a column for a promise that is already settled"
  );
  assert.ok(
    fn.includes("withinOrganization"),
    "the writer takes an id and no slug, so it must restrict by business like assignTask does"
  );
});

test("the board asks for every status, or Done would always be empty", () => {
  assert.ok(
    code.includes('status: "all"'),
    "a board that fetched only open tasks would make every completion look like a card that vanished"
  );
});
