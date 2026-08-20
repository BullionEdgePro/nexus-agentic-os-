// "Check the reply pipeline for this conversation" cost an afternoon.
//
// customer-waiting branched on one boolean. If the AI was not paused it said
// the agent should have answered and told the reader to check the pipeline.
//
// On 2026-08-20 that was read literally, and the pipeline turned out to be
// working perfectly. The truth was a third thing the sentence could not say: a
// colleague had answered the conversation on the 10th, the customer wrote again
// on the 19th while the handoff flag was still set, the agent correctly stayed
// silent, and the flag was cleared afterwards. To one boolean that is
// indistinguishable from a broken platform.
//
// Measured on production the same day: THREE waiting conversations, THREE
// different causes, one sentence between them.
//
//   1  handed to a person, still paused          456.7h
//   2  a colleague replied, then stopped          29.9h   <- the finding
//   4  nothing recorded at all                   131.4h
//
// The fourth case is the one that means the platform. It used to be what you
// got whenever the flag was false -- which is most of the time -- so the
// alarming reading was also the commonest one, and it stopped meaning anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const OPERATORS = readFileSync(
  join(root, "apps", "api", "src", "services", "operators.ts"),
  "utf8"
);

/** The diagnosis function, from its declaration to the next one. */
function diagnosis() {
  const from = OPERATORS.indexOf("function whyNobodyAnswered(row: {");
  const to = OPERATORS.indexOf("function describeOutcome(", from);
  assert.ok(from > -1 && to > from, "whyNobodyAnswered is gone");
  return OPERATORS.slice(from, to);
}

test("the misleading sentence is gone", () => {
  // SCOPED TO WHAT THIS OPERATOR RETURNS. The first version banned the phrase
  // across the whole file and failed twice over: it matched the doc comment
  // quoting the old sentence, and it matched intent-unclassified, which uses
  // "Check the reply pipeline" correctly and about something else. A ban that
  // cannot tell a quotation from a use is not a ban.
  assert.ok(
    !/Check the reply pipeline for this conversation/.test(diagnosis()),
    "the sentence that sent somebody chasing a working pipeline is back"
  );
});

test("all four causes are distinguished", () => {
  const body = diagnosis();
  assert.match(body, /if \(row\.is_human_handoff\)/);
  assert.match(body, /if \(row\.a_human_spoke_before\)/);
  assert.match(body, /if \(row\.recorded_outcome\)/);
  // Four branches: three guarded, one fallback. Counted by the returns
  // themselves rather than by their indentation, which the first version got
  // wrong -- three of the four sit inside an `if` and are indented deeper.
  assert.equal(
    (body.match(/\breturn\b/g) ?? []).length,
    4,
    "a cause was added or lost without the test noticing"
  );
});

test("the platform-fault reading is the fallback, not the default", () => {
  // This is the whole point. It must be reachable ONLY once every other
  // explanation has been ruled out, or it goes back to being the common case
  // and stops carrying any weight.
  const body = diagnosis();
  const escalate = body.indexOf("This is the one to escalate");
  assert.ok(escalate > -1, "the escalation wording is gone");
  for (const guard of ["is_human_handoff", "a_human_spoke_before", "recorded_outcome"]) {
    assert.ok(
      body.indexOf(guard) < escalate,
      `the escalation branch is reachable before ${guard} has been ruled out`
    );
  }
});

test("the half-abandoned case says the agent will take the next message", () => {
  // A colleague replied and stopped. The agent is no longer paused, so the
  // customer's NEXT message gets answered -- but this one will not, ever,
  // because the reply path runs on inbound webhooks and never revisits a
  // backlog. A reader who does not know that will wait for a reply that is not
  // coming.
  const body = diagnosis();
  const branch = body.slice(body.indexOf("a_human_spoke_before"));
  assert.match(branch, /NEXT message/);
  // Matched against the CONCATENATED text. The sentence is assembled from
  // several string literals, so "waiting on a person" straddles a boundary and
  // exists in no single literal -- the first version searched the source and
  // could never have matched.
  const text = [...branch.matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("");
  assert.match(text, /waiting on a person, not on the platform/);
});

test("the outcome is tied to the message that went unanswered", () => {
  // Without the lower bound this reports the outcome of a PREVIOUS exchange as
  // the reason for this silence -- the same class of mistake the whole change
  // exists to remove, produced by a sloppier query.
  const query = OPERATORS.slice(
    OPERATORS.indexOf("as a_human_spoke_before"),
    OPERATORS.indexOf("as recorded_outcome")
  );
  assert.match(query, /cm\.recorded_at >= last\.created_at/);
  assert.match(query, /order by cm\.recorded_at asc/);
});

test("a reply recorded as sent with nothing outbound is called a delivery problem", () => {
  // 'agent' contradicts the operator's own premise: it only selects
  // conversations whose last message is inbound. Papering over that would hide
  // a delivery failure behind "a customer is waiting".
  assert.match(OPERATORS, /That is a delivery problem, not a slow colleague/);
});

test("every recorded outcome the schema allows is described", () => {
  // Migration 057's constraint is the vocabulary. A value the schema permits
  // and this switch does not name would fall to the default and print a raw
  // enum at somebody.
  const schema = readFileSync(
    join(root, "packages", "db", "migrations", "057-a-deliberate-silence-is-an-outcome.sql"),
    "utf8"
  );
  const allowed = [...schema.matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1])
    .filter((v) => ["agent", "fallback", "none", "agent_unrecorded", "skipped_handover"].includes(v));
  assert.ok(allowed.length >= 5, "could not read the outcome vocabulary from migration 057");

  const describe = OPERATORS.slice(OPERATORS.indexOf("function describeOutcome("));
  const body = describe.slice(0, describe.indexOf("\n}"));
  for (const value of new Set(allowed)) {
    assert.ok(
      body.includes(`case "${value}"`),
      `${value} is a permitted outcome with no wording — it would print raw`
    );
  }
});
