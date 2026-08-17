// A handoff flag is a switch that only turns off when a human works the
// conversation. With nobody on the rota it never turns off, so escalating once
// mutes a customer permanently. Found in production: four Zipicka conversations
// muted since 2026-08-01, two of them real people who had said "Hi".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");

// The guard, isolated from the comment that explains it. Four times now a test
// in this repo has passed by matching prose describing the bug.
const GATE = PROCESSOR.slice(
  PROCESSOR.indexOf("const aiPaused = Boolean("),
  PROCESSOR.indexOf("// Switchboard.")
)
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\/\/[^\n]*/g, " ");

test("a handoff nobody can take does not silence the agent", () => {
  assert.ok(GATE.length > 200, "the gate slice must not be empty");
  // The flag is checked against whether a person could actually take it.
  assert.match(GATE, /isHumanHandoff && !aiPaused/);
  // ...AND ASKED OF THE BUSINESS THAT WOULD TAKE IT, not the number's owner.
  // This assertion used to read `hasActiveEmployees(organization.id)`, which is
  // the bug rather than the fix: all five businesses share Zipicka's number, so
  // every conversation row carries Zipicka's organization_id — including the
  // ones routed to ABR and SFS, which have no employees at all. Asking the
  // owner meant this release could never fire for the four businesses that
  // most need it, while passing a test that pinned the wrong shape.
  assert.match(GATE, /businessAnsweringFor\(conversationId, organization\.id\)/);
  assert.match(GATE, /hasActiveEmployees\(answering\)/);
  assert.ok(
    !/hasActiveEmployees\(organization\.id\)/.test(GATE),
    "the owner is the wrong business to ask on a shared number"
  );
  // And the agent runs afterwards rather than returning.
  assert.match(GATE, /isHumanHandoff = false/);
});

test("the stale flag is cleared, so the row stops claiming a human is involved", () => {
  // Without this the release happens on every single message forever, and the
  // inbox keeps showing a conversation as human-handled that nobody is handling.
  assert.match(GATE, /setConversationHandoff\(conversationId, false\)/);
  // Best-effort: failing to clear must not cost the customer their reply.
  assert.match(GATE, /setConversationHandoff\(conversationId, false\)\.catch\(/);
});

test("a deliberate, time-boxed pause is left alone", () => {
  // `aiPausedUntil` is a person taking a conversation for a while and expires by
  // itself — the opposite of the flag above, which only ever turns off. Reading
  // them as the same thing would let this release override somebody who is
  // actively typing.
  assert.match(GATE, /!aiPaused/);
  // The final gate still honours both.
  assert.match(GATE, /if \(isHumanHandoff \|\| aiPaused\)/);
});

test("a database failure keeps the customer's conversation as it was", () => {
  // Same reasoning as the escalation guard: if the staff lookup cannot answer,
  // assume staff exist. Guessing "nobody is here" on a transient error would
  // hand the conversation back to the agent behind a human's back.
  assert.match(GATE, /hasActiveEmployees\(answering\)\.catch\(\(\) => true\)/);
  console.log("PASS: a mute nobody can lift is not a mute");
});

// ============================================================
// The other half: setting the flag asks the same wrong question
// ============================================================

test("pausing the agent is decided by the business being served", () => {
  // `flagHandoffBestEffort` has three callers and every one passes the number's
  // OWNER, because that is what the pipeline has in hand at each point. On a
  // shared number that is Zipicka for all five businesses — so whether to pause
  // the agent on ABR's conversation was being decided by whether Zipicka has
  // somebody at their desk.
  //
  // The release above and this are the two halves of one bug: the flag could be
  // set for a business that cannot take it, and then never cleared because the
  // clearing asked about a different business entirely.
  const FN = PROCESSOR.slice(PROCESSOR.indexOf("async function flagHandoffBestEffort"));
  const body = FN.slice(0, FN.indexOf("\n}"));
  assert.ok(body.length > 200, "the function slice must not be empty");

  assert.match(body, /businessAnsweringFor\(conversationId, organization\.id\)/);
  assert.match(body, /hasStaffOnShift\(answering\)/);
  assert.ok(
    !/hasStaffOnShift\(organization\.id\)/.test(body),
    "the owner is the wrong business to ask on a shared number"
  );
});

test("the serving business is read from the conversation, not trusted from the caller", () => {
  // Resolved in one place rather than threaded through three call sites, for
  // the reason flagHandoffBestEffort already gives about its own guard: a check
  // every caller has to remember is a check the fourth caller will not.
  const FN = PROCESSOR.slice(PROCESSOR.indexOf("async function businessAnsweringFor"));
  const body = FN.slice(0, FN.indexOf("\n}\n"));
  assert.match(body, /getConversationRouting\(conversationId\)/);
  assert.match(body, /routedOrganizationId \?\? ownerId/);
  // Falls back to the owner on failure — which is what these call sites did
  // before, and is correct for a conversation the switchboard never routed.
  assert.match(body, /catch \{[\s\S]{0,60}return ownerId;/);
});
