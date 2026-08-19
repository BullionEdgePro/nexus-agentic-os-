// A customer wrote, the agent chose not to answer, and nothing recorded it.
//
// Found 2026-08-19 while diagnosing a live message that got no reply. The
// conversation was in human handover, so the processor took the skip branch --
// which is the RIGHT behaviour: a person had picked it up on 10 August and the
// customer was addressing them by name. An agent replying over the top of them
// would have been worse than silence.
//
// What was wrong is that the decision left no trace anywhere. `logger.debug` is
// below the level the containers log at, the job completed cleanly so the queue
// showed no failure, and `recordConversationMetric` was never called so no row
// existed. For seven minutes, with full database access, "skipped on purpose"
// was indistinguishable from "the reply path is broken". The owner could not
// have told them apart at all.
//
// This is migration 049's argument arriving through a door 049 did not cover:
// 049 exists because failed replies were absent from the denominator, so the AI
// resolution rate was 100% by construction. A deliberate silence is absent the
// same way -- and more often, because EVERY message into a handed-over
// conversation takes this branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const TYPES = read("packages", "shared", "src", "types.ts");
const MIGRATION = read(
  "packages", "db", "migrations", "057-a-deliberate-silence-is-an-outcome.sql"
);

/** The skip branch only, so an assertion cannot match a neighbouring one. */
function skipBranch() {
  const start = PROCESSOR.indexOf("if (isHumanHandoff || aiPaused) {");
  assert.ok(start > -1, "the skip branch is gone");
  return PROCESSOR.slice(start, PROCESSOR.indexOf("\n  }", start));
}

test("standing down is logged where somebody will see it", () => {
  const branch = skipBranch();
  assert.ok(branch.includes("logger.info("), "debug is below the container log level");
  assert.ok(!branch.includes("logger.debug("), "this decision must not be invisible");
  // The organisation as well as the conversation: a log line naming only a
  // conversation id costs a database query before it means anything.
  assert.match(branch, /organizationId: organization\.id/);
});

test("standing down is recorded as an outcome, not as an absence", () => {
  const branch = skipBranch();
  assert.match(branch, /recordMetricBestEffort\(\{/);
  assert.match(branch, /replyOutcome: "skipped_handover" as const/);
  // Best-effort, like every other metric write on this path: analytics must
  // never be what stops a reply.
  assert.ok(!branch.includes("await recordConversationMetric("), "use the best-effort wrapper");
});

test("the vocabulary allows it and still refuses nonsense", () => {
  assert.match(TYPES, /\| "skipped_handover"/);
  assert.match(MIGRATION, /'agent', 'fallback', 'none', 'agent_unrecorded', 'skipped_handover'/);
  // A constraint that permits everything is the same as no constraint, so the
  // migration proves the new value is accepted rather than assuming it.
  assert.match(MIGRATION, /still refused by the check constraint/);
  // And it cleans up after proving it -- a migration must not leave an
  // analytics row behind.
  assert.match(MIGRATION, /delete from conversation_metrics/);
});

test("intent-unclassified does not treat it as a fault", () => {
  // No classifier runs on a message the agent never handled, so a null intent
  // there is expected. Counting it would raise an URGENT alert every time a
  // person takes a conversation over -- the normal, correct operation of the
  // platform reported as an emergency.
  const start = OPERATORS.indexOf('slug: "intent-unclassified"');
  const body = OPERATORS.slice(start, OPERATORS.indexOf("\n};", start));
  assert.match(body, /coalesce\(reply_outcome, ''\) <> 'skipped_handover'/);
});

test("agent-unavailable excludes it from the DENOMINATOR too", () => {
  // The half that matters. A message the agent stood down from was never a
  // chance for the agent to fail, so leaving it in `total` would make the
  // failure rate look better the more conversations humans take over --
  // migration 049's argument pointing the other way.
  const start = OPERATORS.indexOf('slug: "agent-unavailable"');
  const body = OPERATORS.slice(start, OPERATORS.indexOf("\n};", start));
  const denominator = body.slice(body.indexOf("as total") - 400, body.indexOf("as total"));
  assert.ok(
    denominator.includes("reply_outcome <> 'skipped_handover'"),
    "the denominator must exclude messages the agent was never given"
  );
  // And the numerators are untouched: this is not a failure and must never be
  // counted as one.
  assert.match(body, /filter \(where reply_outcome = 'fallback'\)/);
  assert.match(body, /filter \(where reply_outcome = 'none'\)/);
});

test("the branch still returns without replying", () => {
  // The whole point is that the agent stays out. Recording the fact must not
  // turn into answering over the top of the person handling it.
  const branch = skipBranch();
  assert.match(branch, /return;/);
  assert.ok(!/sendWhatsApp|sendFallback|agent\.respond/.test(branch), "nothing may be sent here");
});
