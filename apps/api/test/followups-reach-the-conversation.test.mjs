// A promise made follows the customer who was promised.
//
// A follow-up used to be written at the moment it was agreed and read on a page
// somebody opened later. Neither is the moment it matters, which is when that
// customer messages again — until now, "did you call me back?" reached an agent
// with no idea a callback had ever been owed, and the fluent answer was a wrong
// one.
//
// Most of this file RUNS the code. describeOpenFollowUps is pure, so its output
// can be asserted directly rather than inferred from its source, which is the
// right way to test the one piece of text a model will read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { describeOpenFollowUps } from "@nexus/agents";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const HANDOVER = read("packages", "agents", "src", "handover.ts");
const TASKS_DB = read("packages", "db", "src", "tasks.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");

const overdue = {
  title: "Call back about the attestation quote",
  dueAt: "2026-08-11T12:00:00.000Z",
  isOverdue: true,
  owner: "Ivan",
};
const undated = { title: "Send the fee schedule", dueAt: null, isOverdue: false, owner: null };

// ============================================================
// 1. The note the model reads
// ============================================================

test("no follow-ups produces no note at all", () => {
  // Not an empty heading. "Outstanding commitments: none" spends context to say
  // nothing and invites the model to announce that there are none.
  assert.equal(describeOpenFollowUps([]), null);
});

test("the note declares what it is before any content", () => {
  const note = describeOpenFollowUps([overdue]);
  assert.ok(note.startsWith("[INTERNAL NOTE"), "the fence must come first");
  assert.match(note, /NOT said to the customer/);
});

test("it forbids the three specific failures, by name", () => {
  const note = describeOpenFollowUps([overdue]);
  // Repeating them as a confirmation, which turns a staff intention into a
  // promise the agent just made.
  assert.match(note, /Do not read them out/);
  assert.match(note, /do not promise any of them will happen/);
  // Claiming one is done — the worst available answer, because the customer
  // stops chasing something that never happened.
  assert.match(note, /never say one has been done/);
  // And it states the inference explicitly rather than leaving it implied.
  assert.match(note, /it has NOT been completed/);
  // Renegotiating the date itself.
  assert.match(note, /do not agree to a new time yourself/);
});

test("an overdue item is marked overdue, using the server's verdict", () => {
  const note = describeOpenFollowUps([overdue]);
  assert.match(note, /was due .* and is OVERDUE/);
  // isOverdue is carried through, never recomputed from this process's clock —
  // the same rule the page and the inbox pane follow.
  assert.equal(describeOpenFollowUps([{ ...overdue, isOverdue: false }]).includes("OVERDUE"), false);
});

test("the due time is rendered in the business's timezone, not the server's", () => {
  // 12:00 UTC is 16:00 in Dubai. Rendered in UTC, a note about a 4pm callback
  // would tell the agent noon — and the agent would repeat the wrong hour if it
  // ever slipped, on a platform whose businesses are all in one zone four hours
  // off UTC.
  const dubai = describeOpenFollowUps([overdue], "Asia/Dubai");
  const utc = describeOpenFollowUps([overdue], "UTC");
  assert.match(dubai, /16:00/);
  assert.match(utc, /12:00/);
  assert.notEqual(dubai, utc);
});

test("an item with no date says so rather than inventing one", () => {
  const note = describeOpenFollowUps([undated]);
  assert.match(note, /no date agreed/);
  assert.ok(!/Invalid Date/.test(note), "a null date must never render as Invalid Date");
});

test("an unassigned item is named as unassigned", () => {
  assert.match(describeOpenFollowUps([undated]), /not yet assigned to anyone/);
  assert.match(describeOpenFollowUps([overdue]), /owed by Ivan/);
});

test("an unparseable date degrades to the raw value, not to a crash", () => {
  // The column is timestamptz so this should be impossible. "Should be
  // impossible" is how the inbound reply path acquires an exception.
  const note = describeOpenFollowUps([{ ...overdue, dueAt: "not-a-date" }]);
  assert.match(note, /not-a-date/);
  assert.ok(!/Invalid Date/.test(note));
});

test("every item appears — none is dropped for brevity", () => {
  const note = describeOpenFollowUps([overdue, undated]);
  assert.match(note, /Call back about the attestation quote/);
  assert.match(note, /Send the fee schedule/);
});

// ============================================================
// 2. The brief, where a colleague reads it
// ============================================================

test("follow-ups are fetched before anything that can fail, and survive it", () => {
  // The summary is prose a model wrote. These are records staff entered, and
  // they are exactly what the employee is about to contradict. They must reach
  // the brief when there is no transcript, no API key, and no model.
  const fn = HANDOVER.slice(HANDOVER.indexOf("export async function buildHandoverBrief"));
  const fetchIndex = fn.indexOf("listOpenTasksForConversation");
  const historyIndex = fn.indexOf("loadRecentHistory");
  assert.ok(fetchIndex !== -1 && fetchIndex < historyIndex, "follow-ups must load first");

  // Every early return carries them.
  for (const reason of [
    "Could not read the conversation history.",
    "Nothing has been said in this conversation yet.",
    "Summaries are not configured on this deployment.",
    "The summary came back empty.",
    "The summary could not be generated just now.",
  ]) {
    const at = fn.indexOf(reason);
    assert.ok(at !== -1, `missing return: ${reason}`);
    const tail = fn.slice(at, at + 120);
    assert.match(tail, /followUps/, `"${reason}" must still carry the follow-ups`);
  }
});

test("the fetch cannot fail the handoff", () => {
  // The employee taking the conversation is the operation that matters.
  assert.match(HANDOVER, /listOpenTasksForConversation\(conversationId\)\.catch\(\(\) => \[\]\)/);
});

test("they are never passed through the summariser", () => {
  // Asked to summarise, a model turns "call back Tuesday 4pm, owed by Ivan"
  // into "we said we'd get back to them" — dropping the only two parts anyone
  // can act on. And many follow-ups are not in the transcript at all.
  const prompt = HANDOVER.slice(HANDOVER.indexOf("A colleague is about to"), HANDOVER.indexOf("Transcript:"));
  assert.ok(prompt.length > 200, "the prompt slice must not be empty");
  assert.ok(!/followUp/i.test(prompt), "follow-ups must not enter the prompt");
});

// ============================================================
// 3. The reply path
// ============================================================

test("the lookup is scoped to the serving business and the contact", () => {
  // On a shared number the same person talks to a shop and a law firm. Using
  // the number's owner here would surface one business's obligations to
  // another's agent — and the output would look entirely normal.
  assert.match(PROCESSOR, /listOpenTasksForContact\(serving\.id, contactId\)/);
  assert.match(TASKS_DB, /where t\.organization_id = \$1\s*\n\s*and t\.contact_id = \$2\s*\n\s*and t\.status = 'open'/);
});

test("a follow-up lookup cannot delay or break a customer's reply", () => {
  // The inbound path is the one thing that must never degrade. An empty list
  // and a failed lookup are indistinguishable downstream, which is correct:
  // both mean "nothing to add".
  assert.match(PROCESSOR, /listOpenTasksForContact\(serving\.id, contactId\)\.catch\(\(\) => \[\]\)/);
});

test("memory and obligations stay separate notes", () => {
  // Different kinds of fact carrying different cautions — what we know about
  // someone versus what we owe them and must not claim to have done. Merged,
  // it would be unclear which warning governs which half.
  assert.match(PROCESSOR, /const notes = \[recalled \? recallNote\(recalled\) : null, owedNote\]/);
  assert.match(PROCESSOR, /function recallNote\(recalled: string\): string/);
});

test("the promise reaches the conversation from any earlier one", () => {
  // Owing someone a callback does not expire because they opened a new thread,
  // and a follow-up raised from the deck belongs to no conversation at all.
  const fn = TASKS_DB.slice(TASKS_DB.indexOf("export async function listOpenTasksForContact"));
  const query = fn.slice(0, fn.indexOf("[organizationId, contactId]"));
  assert.ok(!/conversation_id/.test(query), "must not narrow to one conversation");
  console.log("PASS: an open promise follows the customer into their next message");
});
