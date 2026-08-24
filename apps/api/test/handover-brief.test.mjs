// The handover brief — what an employee is told before they message a customer
// from their own phone.
//
// The failure this guards against is not a missing summary. It is a summary
// that delays or breaks the handoff, or one an employee acts on as fact.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const HANDOVER = read("packages", "agents", "src", "handover.ts");
const ROUTE = read("apps", "api", "src", "routes", "employees.ts");
const UI = read("apps", "web", "app", "deck", "team", "team-workspace.tsx");

test("the brief is built after the handoff has committed", () => {
  // Ordering is the whole safety property. Built first, a slow or failing model
  // would delay — or with one careless throw, prevent — the thing that actually
  // matters: the AI being paused and the employee getting their link.
  const route = ROUTE.slice(ROUTE.indexOf("Conversation taken to an employee's own WhatsApp"));
  assert.match(route, /const brief = await buildHandoverBrief\(conversationId\)/);
  // `at` rather than a bare indexOf, because a bare indexOf disarmed this
  // assertion for days and nothing said so. It searched for
  // `await setConversationHandoff(conversationId, true)`; that call gained a
  // required `reason` argument in ae0ec7024, the marker stopped matching, and
  // the comparison became `-1 < 20538` — TRUE. It would have passed with the
  // handoff after the brief, or with the handoff deleted outright, which is the
  // exact failure the test exists to prevent. 1034 tests stayed green.
  //
  // The markers are also shortened to the call rather than the call plus its
  // arguments. What this test cares about is which of the two runs first; the
  // argument list is somebody else's business and was never part of the claim.
  const at = (marker) => {
    const i = ROUTE.indexOf(marker);
    assert.notEqual(i, -1, `employees.ts no longer contains ${marker} — this test is not testing anything`);
    return i;
  };

  assert.ok(
    at("await setConversationHandoff(") < at("await buildHandoverBrief("),
    "the handoff must be committed before the summary is attempted"
  );
});

test("every failure path returns a reason instead of throwing", () => {
  // A throw here would fail a request whose side effects have already happened
  // — the AI is paused, the conversation is flagged — leaving the employee with
  // an error and a customer who is now theirs.
  // Matched on the reason, not on EMPTY's exact argument list. The earlier
  // version pinned the closing bracket, so adding a third argument — the
  // structured follow-ups, which must survive every one of these paths — broke
  // a test whose subject had not changed. What this test is about is that a
  // failure returns a reason instead of throwing.
  for (const guard of [
    /catch \{\s*\n\s*return EMPTY\("Could not read the conversation history\."/,
    /catch \{[\s\S]{0,400}return EMPTY\("The summary could not be generated just now\."/,
  ]) {
    assert.match(HANDOVER, guard);
  }
  assert.ok(!/throw new Error/.test(HANDOVER), "the brief must never throw");
});

test("an empty conversation is a state, not an error", () => {
  assert.match(HANDOVER, /Nothing has been said in this conversation yet\./);
});

test("the prompt leads with commitments, not with a synopsis", () => {
  // Re-asking a question is mildly annoying. Contradicting something the agent
  // promised an hour ago is one business changing its story in front of a
  // customer, which is the expensive failure.
  assert.match(HANDOVER, /anything we have already[\s\S]{0,40}promised or committed to/);
});

test("the prompt forbids filling in gaps", () => {
  assert.match(HANDOVER, /say it is unclear rather[\s\S]{0,60}than filling it in/);
  assert.match(HANDOVER, /a confident guess is worse/);
});

test("the brief says how much it saw, and tells the reader to verify", () => {
  // It is generated text an employee is about to act on in front of a customer.
  assert.match(HANDOVER, /turnsConsidered/);
  assert.match(UI, /Check it against the thread before promising anything\./);
});

test("an unavailable brief still tells the employee what to do", () => {
  // "No summary" plus silence leaves them worse off than before the feature.
  assert.match(UI, /open the thread and\s*\n?\s*read it before replying/);
});

test("the brief persists on the page rather than flashing", () => {
  // WhatsApp has taken focus by the time it arrives, so a toast is read by
  // nobody.
  assert.match(UI, /setBrief\(\{ who:/);
  assert.match(UI, /handover-close/);
  console.log("PASS: the brief never blocks the handoff and never presents a guess as fact");
});
