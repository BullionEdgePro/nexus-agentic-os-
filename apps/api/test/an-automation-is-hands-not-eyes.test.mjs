/**
 * Automations: what they may react to, what they may do, and the line they hold.
 *
 * ============================================================
 * THE DESIGN THIS PINS
 * ============================================================
 *
 * F7's third word. The obvious build is a rules engine that watches the tasks
 * table — "when a follow-up is overdue and unowned, assign it" — and it is the
 * wrong build for a reason already in this repository: `overdue-followup` and
 * `unowned-followup` watch those exact rows every ten minutes. A second
 * evaluator is two pieces of code answering one question, and the day they
 * disagree, one is wrong on a screen nobody is comparing.
 *
 * So an automation reacts to a FINDING the sweep has already raised. The
 * operators stay the only eyes. These tests hold that apart from the tempting
 * version of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  AUTOMATION_ACTIONS,
  AUTOMATION_TRIGGERS,
  automationActsOn,
  automationRefusal,
} from "@nexus/db";
import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const RUNNER = withoutComments(
  readFileSync(join(root, "apps", "api", "src", "services", "automation-runner.ts"), "utf8")
);
const MIGRATION = readFileSync(
  join(root, "packages", "db", "migrations", "064-the-operators-are-the-eyes-not-the-hands.sql"),
  "utf8"
);

// ============================================================
// The line
// ============================================================

test("an automation cannot say anything to a customer", () => {
  // THE BOUNDARY, and it is held by the shape rather than by care. Both actions
  // are things a colleague does: give somebody the work, or write the work
  // down. Sending a message is a thing the BUSINESS does, and an automation
  // that could do it would be a wider grant than the reply path itself has —
  // that path stands down entirely when a person holds the conversation, and
  // withholds a callback promise when nobody is on the rota.
  assert.deepEqual([...AUTOMATION_ACTIONS], ["assign_followup", "create_followup"]);

  for (const forbidden of ["sendMessage", "insertOutboundMessage", "sendWhatsApp", "broadcast"]) {
    assert.ok(
      !RUNNER.includes(forbidden),
      `the runner reaches for ${forbidden} — an automation must never speak to a customer`
    );
  }
});

test("the runner does not become a second watcher", () => {
  // If this ever reads `tasks` to decide FOR ITSELF what is overdue or unowned,
  // the design has collapsed into the thing it was built to avoid.
  assert.ok(
    RUNNER.includes("listOpenFindings"),
    "an automation acts on what the operators found, not on its own reading of the tables"
  );
  assert.ok(
    !RUNNER.includes("listTasks("),
    "the runner must not evaluate task conditions itself — that is what the operators are for"
  );
});

test("it reads findings itself rather than being handed the dispatch payload", () => {
  // raisedThisSweep deliberately carries no subject, because it is built for
  // dispatch OUTSIDE the platform and a finding's title names a customer.
  // Widening it to feed the automations would put customer names into the
  // payload that leaves the building.
  const OPERATORS = withoutComments(
    readFileSync(join(root, "apps", "api", "src", "services", "operators.ts"), "utf8")
  );
  assert.ok(
    OPERATORS.includes("runAutomations(organizations.map("),
    "the sweep should hand the runner business ids, not findings"
  );
  assert.ok(
    !OPERATORS.includes("runAutomations(raisedThisSweep"),
    "the dispatch payload carries no subject on purpose and must not start"
  );
});

// ============================================================
// What may be paired with what
// ============================================================

test("assigning needs somebody to assign to", () => {
  const refusal = automationRefusal({
    action: "assign_followup",
    triggerOperator: "unowned-followup",
    assigneeId: null,
  });
  assert.ok(refusal);
  assert.match(refusal.reason, /cannot assign work to nobody/);
});

test("an action is refused on a finding it could not act on", () => {
  // customer-waiting's subject is a conversation. Assigning it as though it
  // were a task would either fail obscurely or, worse, assign something else.
  const refusal = automationRefusal({
    action: "assign_followup",
    triggerOperator: "customer-waiting",
    assigneeId: "emp-1",
  });
  assert.ok(refusal);
  assert.match(refusal.reason, /does not report anything this action can act on/);
});

test("the platform cannot be automated to react to its own automatic acts", () => {
  // procedure-switched-on is F14 announcing that it changed something. An
  // automation triggered by it would be the platform reacting to itself, which
  // is how a loop starts.
  for (const action of AUTOMATION_ACTIONS) {
    assert.ok(
      !AUTOMATION_TRIGGERS[action].operators.includes("procedure-switched-on"),
      `${action} may be triggered by the platform's own automatic act`
    );
  }
});

test("a refusal is a sentence somebody can act on", () => {
  const refusal = automationRefusal({ action: "delete_everything", triggerOperator: "x" });
  assert.ok(refusal);
  assert.ok(refusal.reason.length > 20, "a refusal that says 'invalid' teaches nothing");
  assert.match(refusal.reason, /assign a follow-up, or write one/);
});

test("a legal pair is allowed", () => {
  assert.equal(
    automationRefusal({
      action: "assign_followup",
      triggerOperator: "unowned-followup",
      assigneeId: "emp-1",
    }),
    null
  );
  assert.equal(
    automationRefusal({ action: "create_followup", triggerOperator: "customer-waiting" }),
    null
  );
});

// ============================================================
// Which findings it actually touches
// ============================================================

const spec = (over = {}) => ({
  action: "assign_followup",
  triggerOperator: "unowned-followup",
  assigneeId: "emp-1",
  isActive: true,
  ...over,
});
const finding = (over = {}) => ({
  operator: "unowned-followup",
  subjectKind: "task",
  subjectId: "task-1",
  ...over,
});

test("it acts on its own trigger and nothing else", () => {
  assert.equal(automationActsOn(spec(), finding()), true);
  assert.equal(automationActsOn(spec(), finding({ operator: "customer-waiting" })), false);
});

test("a switched-off automation does nothing", () => {
  assert.equal(automationActsOn(spec({ isActive: false }), finding()), false);
});

test("a finding with no subject is not acted on", () => {
  // "The whole business" is not a follow-up. booking-without-anyone fires on an
  // ABSENCE and has nothing to touch.
  assert.equal(automationActsOn(spec(), finding({ subjectId: null })), false);
  assert.equal(automationActsOn(spec(), finding({ subjectKind: null })), false);
  assert.equal(automationActsOn(spec(), finding({ subjectKind: "agent_config" })), false);
});

// ============================================================
// Acting once
// ============================================================

test("the claim is written before the act, and losing it is normal", () => {
  // A finding STANDS until it stops being true, so it is present in six sweeps
  // an hour. An automation acting on presence would assign the same task six
  // times before lunch.
  const claimAt = RUNNER.indexOf("claimFinding(");
  const performAt = RUNNER.indexOf("perform(automation");
  assert.ok(claimAt > -1 && performAt > -1, "the runner no longer claims before acting");
  assert.ok(claimAt < performAt, "the claim must be written BEFORE the action, or a crash repeats it");
  assert.ok(RUNNER.includes("if (!runId) continue;"), "losing the claim is the normal case, not an error");
});

test("the database decides the race, not a read-then-write", () => {
  // Two halves in two files, and the test needs both: the INDEX makes the
  // conflict possible, and the INSERT is the thing that loses gracefully.
  // Checking a read-then-write would look identical in a passing test and
  // would let two overlapping sweeps both act.
  assert.match(MIGRATION, /automation_runs_once_per_finding/);
  const AUTOMATIONS = readFileSync(join(root, "packages", "db", "src", "automations.ts"), "utf8");
  assert.ok(
    AUTOMATIONS.includes("on conflict (automation_id, finding_id) do nothing"),
    "the claim must be an insert the database can refuse, not a select followed by an insert"
  );
});

test("a failed act is recorded and not retried", () => {
  // An automation that cannot assign because the person has left will not start
  // working in ten minutes, and retrying writes the same sentence six times an
  // hour into a log somebody is supposed to read.
  assert.ok(RUNNER.includes("recordAutomationFailure("));
  assert.match(MIGRATION, /failed_reason/);
});

test("the run record outlives the finding it acted on", () => {
  // A finding is retracted and re-raised as the world changes. If the run row
  // went with it, the same act would happen again the moment it came back.
  assert.ok(
    !/finding_id\s+uuid\s+not null\s+references/.test(MIGRATION),
    "automation_runs.finding_id must NOT be a foreign key — the record must survive retraction"
  );
});

test("both new tables are tenant-scoped, and the write is no wider than the read", () => {
  const CLIENT = readFileSync(join(root, "packages", "db", "src", "client.ts"), "utf8");
  assert.ok(CLIENT.includes('"automations"'), "automations is not in TENANT_SCOPED_TABLES");
  assert.ok(CLIENT.includes('"automation_runs"'), "automation_runs is not in TENANT_SCOPED_TABLES");
  assert.match(MIGRATION, /enable row level security/);
  // rls-verify enforces this against production; asserted here so the migration
  // cannot ship with a widened write in the first place.
  assert.ok(
    !MIGRATION.includes("routed_organization_id"),
    "neither table has a serving-business dimension, so neither write should widen"
  );
});
