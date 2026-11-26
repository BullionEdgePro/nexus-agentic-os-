/**
 * Staff-first compact Nexus, piece 2 (26 Nov 2026): on My queue a staff member
 * sees their chats first — the folder sidebar folds behind a "Filters" button
 * that says how many filters are on, the queue chips keep one phone row, and
 * their own rows leave out the line that names them. Admins: unchanged.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-my-queue-design.md
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as layout from "@/lib/inbox-layout";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// ---- Task 1: the rules ---------------------------------------------------------------------------

test("Filters start folded for staff, open for an admin; a stored choice wins", () => {
  const { filtersStartOpen } = layout;
  assert.equal(typeof filtersStartOpen, "function", "lib/inbox-layout exports no filtersStartOpen");
  assert.equal(filtersStartOpen(true, null), false);
  assert.equal(filtersStartOpen(false, null), true);
  assert.equal(filtersStartOpen(true, "open"), true);
  assert.equal(filtersStartOpen(false, "closed"), false);
  assert.equal(filtersStartOpen(true, "junk"), false);
});

test("the Filters count: anything on beyond the staff's own queue view", () => {
  const { activeFilterCount } = layout;
  assert.equal(typeof activeFilterCount, "function", "lib/inbox-layout exports no activeFilterCount");
  const Q = ["awaiting", "snoozed", "followup", "mine"];
  const base = { folder: "awaiting", tag: null, channel: null, dateRange: "any", stage: null, owner: "" };
  assert.equal(activeFilterCount(base, Q), 0);
  assert.equal(activeFilterCount({ ...base, folder: "late" }, Q), 1);
  assert.equal(activeFilterCount({ ...base, folder: "late", tag: "villa" }, Q), 2);
  assert.equal(activeFilterCount({ folder: "late", tag: "villa", channel: "email", dateRange: "7d", stage: "Viewing", owner: "e2" }, Q), 6);
  // An admin has no queue view: any folder is theirs to pick, only the View filters count.
  assert.equal(activeFilterCount({ ...base, folder: "late" }, null), 0);
  assert.equal(activeFilterCount({ ...base, folder: "late", tag: "villa" }, null), 1);
});

test("a staff member's own row leaves out the line that names them", () => {
  const { showsAssignee } = layout;
  assert.equal(typeof showsAssignee, "function", "lib/inbox-layout exports no showsAssignee");
  assert.equal(showsAssignee({ assignedEmployeeId: "e1" }, "e1"), false);
  assert.equal(showsAssignee({ assignedEmployeeId: "e2" }, "e1"), true);
  assert.equal(showsAssignee({ assignedEmployeeId: null }, "e1"), true);
  assert.equal(showsAssignee({ assignedEmployeeId: "e1" }, null), true);
});
