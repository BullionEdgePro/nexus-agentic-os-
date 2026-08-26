/**
 * Unticking "Human handoff" gives the agent the conversation back.
 *
 * ============================================================
 * IT DID NOT, AND THE LABEL SAID IT DID
 * ============================================================
 *
 * `pauseAiForContact` had exactly one writer and no way back. `ai_paused_until`
 * expired by time and by nothing else — right for the case it was built for, a
 * person taking a conversation for a while, and wrong for the case the inbox
 * actually offers.
 *
 * The toggle was asymmetrical. Turning it ON set the flag AND paused the agent
 * for twenty-four hours. Turning it OFF cleared the flag and left the pause
 * exactly where it was. So:
 *
 *   somebody replies in the inbox        agent paused 24h, handoff on
 *   they finish and untick the box       handoff off, agent STILL paused
 *   the customer writes back that day    the conversation is not flagged as
 *                                        human-held, so nobody is watching it,
 *                                        and the agent will not answer
 *
 * Silence, from the one control whose whole meaning is "the agent has this
 * back". `customer-waiting` would eventually notice, which is the difference
 * between this and the permanent mutes elsewhere in these tests — but only
 * after the warn threshold, and only if somebody reads the deck.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const DB = read("packages", "db", "src", "conversations.ts");
const ROUTE = withoutComments(read("apps", "api", "src", "routes", "conversations.ts"));
const PROCESSOR = withoutComments(read("apps", "api", "src", "queue", "processor.ts"));
const INBOX = withoutComments(read("apps", "web", "app", "inbox", "page.tsx"));

// ============================================================
// The pause has a way back
// ============================================================

test("something can clear the pause, not only set it", () => {
  assert.ok(
    DB.includes("export async function resumeAiForContact"),
    "ai_paused_until still has one writer and no way back"
  );
  assert.ok(
    DB.includes("set ai_paused_until = null"),
    "the resume does not actually clear the pause"
  );
});

test("the toggle is symmetrical", () => {
  // The defect in one line: an `if` with no `else`.
  const at = ROUTE.indexOf("body.isHumanHandoff, \"manual_toggle\"");
  assert.ok(at > -1, "the manual toggle is gone");
  const after = ROUTE.slice(at, at + 600);
  assert.ok(after.includes("pauseAiForContact("), "turning it on no longer pauses the agent");
  assert.ok(
    after.includes("resumeAiForContact("),
    "turning it off does not give the agent the conversation back"
  );
});

// ============================================================
// What must NOT change
// ============================================================

test("replying in the inbox still takes the conversation", () => {
  // The implicit takeover is the common path and is correct: a person who has
  // just typed a reply is handling it, and the agent must not answer over them.
  const at = ROUTE.indexOf('"human_replied"');
  assert.ok(at > -1, "sending no longer records a takeover");
  const around = ROUTE.slice(Math.max(0, at - 400), at + 200);
  assert.ok(around.includes("pauseAiForContact("), "sending no longer pauses the agent");
});

test("the timed expiry is untouched", () => {
  // The pause still lapses on its own. This adds a second way out, it does not
  // replace the first — a person who takes a conversation and never comes back
  // must still have it returned to the agent by the clock.
  assert.ok(DB.includes("ai_paused_until = now() + ($2 || ' hours')::interval"));
  assert.ok(
    PROCESSOR.includes("new Date(aiPausedUntil).getTime() > Date.now()"),
    "the reply path no longer honours the pause window"
  );
});

test("the stale-release for a business with no staff is untouched", () => {
  // A different problem with a different fix: a handoff nobody can ever pick up
  // is released by the processor. That reads the ROTA rather than presence, so
  // it does not hand a conversation back at 3am, and it must keep doing so.
  assert.ok(PROCESSOR.includes('"stale_release"'), "the stale release is gone");
  assert.ok(
    PROCESSOR.includes("hasActiveEmployees(answering)"),
    "the release no longer asks whether anybody could take it"
  );
});

// ============================================================
// The control that means it
// ============================================================

test("the inbox offers the toggle both ways", () => {
  // A checkbox, so it is one control with two states rather than a "take over"
  // button and no way back — which is the shape the API had underneath it.
  assert.ok(INBOX.includes('type="checkbox"'), "the handoff control is not a two-way control");
  assert.ok(INBOX.includes("setHumanHandoff(activeConversation.id, e.target.checked)"));
});

test("the custody record still says who did it", () => {
  // manual_toggle is the only writer that can go either way, so its recorded
  // `held` is the only one not implied by its reason.
  assert.ok(ROUTE.includes('"manual_toggle"'));
  assert.ok(
    ROUTE.includes("scope") && ROUTE.includes("actor"),
    "an unattributed toggle is still worth recording, but attribution should be tried"
  );
});
