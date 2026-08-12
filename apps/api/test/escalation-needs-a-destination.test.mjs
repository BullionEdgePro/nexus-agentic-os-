// Escalation used to promise a person who might not exist.
//
// Two paths escalate: governance deciding an answer is too risky, and the agent
// failing outright. Both told the customer "I'm looping in a specialist from our
// team — they'll follow up shortly" and then set is_human_handoff, which PAUSES
// the agent.
//
// Both are correct when somebody is on the rota. With an empty one they combine
// into the worst outcome available: the customer is promised help and cut off
// from the only thing answering them, in the same breath. Nothing errors, no
// counter moves, and the conversation reads as healthy. One sat that way from
// 2026-08-01 until an operator noticed eleven days later — noticed by watching
// for the ABSENCE of an event, because there was no event to catch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const EMPLOYEES_DB = read("packages", "db", "src", "employees.ts");

// ============================================================
// The agent is only silenced when somebody can replace it
// ============================================================

test("the pause is guarded in ONE place, not at each call site", () => {
  // flagHandoffBestEffort has three callers. A check every caller must remember
  // is a check the fourth caller will not, so it lives inside the function that
  // does the pausing.
  const fn = PROCESSOR.slice(PROCESSOR.indexOf("async function flagHandoffBestEffort"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(body.length > 200, "the function slice must not be empty");

  const guard = body.indexOf("hasActiveEmployees");
  const pause = body.indexOf("setConversationHandoff");
  assert.ok(guard !== -1, "the guard must be present");
  assert.ok(guard < pause, "it must run before the pause");
  assert.match(body, /if \(!canHandOver\) \{[\s\S]{0,300}return;/);
});

test("the governance path checks the SERVING business, not the number owner", () => {
  // On a shared number the law firm may have staff while the retailer does not.
  // The question is whether anyone can pick up THIS conversation.
  assert.match(PROCESSOR, /hasActiveEmployees\(serving\.id\)/);
});

test("both escalation paths are covered, not just the governance one", () => {
  // The agent failing outright is the more common route into this state, and it
  // goes through sendFallbackBestEffort rather than the governance branch.
  const fallback = PROCESSOR.slice(PROCESSOR.indexOf("async function sendFallbackBestEffort"));
  const body = fallback.slice(0, fallback.indexOf("\n}"));
  assert.match(body, /hasActiveEmployees\(organization\.id\)/);
  assert.match(body, /canHandOver \? FALLBACK_REPLY : FALLBACK_REPLY_NO_STAFF/);
});

// ============================================================
// What the customer is told
// ============================================================

test("with nobody on the rota, the reply promises nobody", () => {
  const noStaff = PROCESSOR.slice(
    PROCESSOR.indexOf("const FALLBACK_REPLY_NO_STAFF"),
    PROCESSOR.indexOf("// How many times a customer")
  );
  assert.ok(noStaff.length > 60, "the constant slice must not be empty");
  // The original promises a person and a timeframe. This must do neither.
  assert.ok(!/specialist/i.test(noStaff), "must not promise a specialist");
  assert.ok(!/follow up/i.test(noStaff), "must not promise a follow-up");
  assert.ok(!/shortly/i.test(noStaff), "must not promise a timeframe");
  // And it keeps the conversation moving rather than closing it off.
  assert.match(noStaff, /\?/, "it should ask the customer something");
});

test("the staffed reply is unchanged", () => {
  // This behaviour was correct all along for businesses with a rota. The fix
  // narrows when it applies; it does not rewrite it.
  assert.match(
    PROCESSOR,
    /const FALLBACK_REPLY =\s*\n\s*"Thanks for your message — I want to make sure you get an accurate answer, so I'm looping in a specialist from our team\. They'll follow up shortly\."/
  );
});

// ============================================================
// Failing the lookup must not change behaviour
// ============================================================

test("a failed staff lookup assumes there IS somebody", () => {
  // The conservative reading. Wrongly assuming empty would weaken a reply and
  // skip a warranted handoff; wrongly assuming staffed behaves exactly as the
  // system did before this change existed. On a transient database error the
  // safer regression is the one that changes nothing.
  const occurrences = PROCESSOR.match(/hasActiveEmployees\([^)]*\)\.catch\(\(\) => true\)/g) ?? [];
  assert.equal(occurrences.length, 3, "every call site must default to true on failure");
});

test("the empty-rota case is logged, because nothing else would show it", () => {
  // The whole failure mode is that it looks like nothing happened.
  assert.match(PROCESSOR, /no active staff/i);
  assert.match(PROCESSOR, /would abandon this conversation rather than transfer it/);
});

// ============================================================
// The lookup itself
// ============================================================

test("it counts rather than listing", () => {
  // The caller needs a yes/no. Fetching every employee's full profile to answer
  // it on the reply path is work nobody uses.
  const fn = EMPLOYEES_DB.slice(EMPLOYEES_DB.indexOf("export async function hasActiveEmployees"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /select count\(\*\)::text as n from employees/);
  assert.match(body, /is_active = true/);
  console.log("PASS: the agent is only silenced when somebody exists to take its place");
});
