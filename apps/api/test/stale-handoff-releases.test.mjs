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
  assert.match(GATE, /hasActiveEmployees\(organization\.id\)/);
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
  assert.match(GATE, /hasActiveEmployees\(organization\.id\)\.catch\(\(\) => true\)/);
  console.log("PASS: a mute nobody can lift is not a mute");
});
