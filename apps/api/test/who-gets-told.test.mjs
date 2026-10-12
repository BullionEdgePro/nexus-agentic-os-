// Who gets told (spec 2026-10-09-nexus-mobile-app-design.md, "Push
// notifications", dispatcher). One pure function decides; these run it for real.
// The rules: a customer writing into an assigned chat tells the person it is
// assigned to; an unassigned one tells whoever of that business is on shift and
// asked to hear about everything, and the owner when nobody is; a chat handed to
// someone tells them. Nothing the team itself did — a reply, a note, a status
// change — ever buzzes a phone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideRecipients } from "../src/services/push-rules.ts";

const OWNERS = ["o:a1"];
const staff = (...rows) => rows.map(([employeeId, active, onShift]) => ({ employeeId, active, onShift }));
const ctx = (over) => ({
  direction: "inbound",
  kind: "message",
  assigneeEmployeeId: null,
  newAssigneeEmployeeId: null,
  staff: [],
  ownerSubjects: OWNERS,
  ...over,
});

test("a message in an assigned chat tells the person it is assigned to", () => {
  assert.deepEqual(
    decideRecipients(ctx({ assigneeEmployeeId: "e1", staff: staff(["e1", true, false]) })),
    [{ subjects: ["e:e1"], requiresMode: "mine" }],
    "assigned to you reaches you on shift or off"
  );
});

test("a chat assigned to someone who has left goes to whoever is on, then the owner", () => {
  assert.deepEqual(
    decideRecipients(ctx({ assigneeEmployeeId: "e1", staff: staff(["e1", false, false], ["e2", true, true]) })),
    [{ subjects: ["e:e2"], requiresMode: "all" }]
  );
  assert.deepEqual(
    decideRecipients(ctx({ assigneeEmployeeId: "e1", staff: staff(["e1", false, false]) })),
    [{ subjects: OWNERS, requiresMode: "all" }]
  );
});

test("an unassigned message tells the staff on shift who asked to hear everything", () => {
  assert.deepEqual(
    decideRecipients(ctx({ staff: staff(["e2", true, true], ["e3", true, false], ["e5", false, true]) })),
    [{ subjects: ["e:e2"], requiresMode: "all" }]
  );
});

test("an unassigned message with nobody on shift tells the owner", () => {
  assert.deepEqual(
    decideRecipients(ctx({ staff: staff(["e3", true, false]) })),
    [{ subjects: OWNERS, requiresMode: "all" }]
  );
});

test("an assignment tells the new assignee, not the one before", () => {
  assert.deepEqual(
    decideRecipients(
      ctx({ direction: null, kind: "assigned", assigneeEmployeeId: "e1", newAssigneeEmployeeId: "e4", staff: staff(["e4", true, false]) })
    ),
    [{ subjects: ["e:e4"], requiresMode: "mine" }]
  );
});

test("an assignment to someone who has left tells nobody", () => {
  assert.deepEqual(
    decideRecipients(ctx({ direction: null, kind: "assigned", newAssigneeEmployeeId: "e4", staff: staff(["e4", false, false]) })),
    []
  );
});

test("what the team did itself never buzzes a phone", () => {
  assert.deepEqual(decideRecipients(ctx({ direction: "outbound", assigneeEmployeeId: "e1", staff: staff(["e1", true, true]) })), []);
  assert.deepEqual(decideRecipients(ctx({ direction: null, kind: "other", staff: staff(["e1", true, true]) })), []);
});

test("no owner on record and nobody on shift means nobody, not an empty send", () => {
  assert.deepEqual(decideRecipients(ctx({ ownerSubjects: [] })), []);
});
