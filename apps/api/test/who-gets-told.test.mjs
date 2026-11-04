// Who gets told (spec 2026-10-09-nexus-mobile-app-design.md, "Push
// notifications", dispatcher). One pure function decides; these run it for real.
// The rules: a customer writing into an assigned chat tells the person it is
// assigned to; an unassigned one tells the owners (admins) who asked to hear
// every new chat -- never the staff on shift, who under the own-book rule cannot
// open it (phone push, 4 Nov 2026); a chat handed to someone tells them. Nothing the team itself did — a reply, a note, a status
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

test("a chat assigned to someone who has left goes to the owners, not to the staff on shift", () => {
  assert.deepEqual(
    decideRecipients(ctx({ assigneeEmployeeId: "e1", staff: staff(["e1", false, false], ["e2", true, true]) })),
    [{ subjects: OWNERS, requiresMode: "all" }]
  );
  assert.deepEqual(
    decideRecipients(ctx({ assigneeEmployeeId: "e1", staff: staff(["e1", false, false]) })),
    [{ subjects: OWNERS, requiresMode: "all" }]
  );
});

test("an unassigned message tells the owners who asked to hear every new chat, never the staff on shift", () => {
  // The staff member could not open it (own book: an unassigned chat is the
  // admins'), and the alert carried the customer's name and, with previews on,
  // their words (audit, 4 Nov 2026).
  assert.deepEqual(
    decideRecipients(ctx({ staff: staff(["e2", true, true], ["e3", true, false], ["e5", false, true]) })),
    [{ subjects: OWNERS, requiresMode: "all" }]
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

test("no owner on record means nobody, not an empty send -- and still not the staff", () => {
  assert.deepEqual(decideRecipients(ctx({ ownerSubjects: [] })), []);
  assert.deepEqual(decideRecipients(ctx({ ownerSubjects: [], staff: staff(["e2", true, true]) })), []);
});
