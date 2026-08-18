// The AI resolution rate was 100%, and it was 100% by construction.
//
// Measured on production: conversation_metrics held 12 rows, every one
// resolved_by = 'ai_agent'. Beside them sat 4 outbound messages carrying the
// "looping in a specialist" fallback, sent on 2026-08-01 across 4 conversations
// — with NO METRIC ROW AT ALL.
//
// The cause is structural rather than an oversight. `recordMetricBestEffort` is
// called near the end of the reply pipeline's `try`, so a model that throws
// jumps straight past it to the `catch` that sends the fallback. Only replies
// the model managed to produce were ever counted, and a rate over a denominator
// that excludes every failure can only come out at 100%.
//
// That matters here more than it would elsewhere, because the hidden failure is
// one this platform has actually had twice — gemini-2.5-flash returning 404 for
// new keys, and an Anthropic key with no credit. Both times every customer got
// the fallback while every container reported healthy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const METRICS = read("packages", "db", "src", "metrics.ts");
const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const MIGRATION = read("packages", "db", "migrations", "049-reply-outcome.sql");
const SCHEMA_CHECK = read("apps", "api", "src", "scripts", "schema-check.ts");

/** The catch block that used to record nothing. */
const CATCH = PROCESSOR.slice(
  PROCESSOR.indexOf('logger.error({ conversationId, sentToCustomer, err }'),
  PROCESSOR.indexOf("// The contact memory is written AFTER")
);

test("a failed reply now leaves a row where it used to leave nothing", () => {
  // The single assertion this whole feature reduces to: the catch path writes a
  // metric. Without it the conversation is absent from every denominator
  // computed from this table — resolution rate, token spend, intent coverage.
  assert.match(CATCH, /recordMetricBestEffort\(\{/);
  assert.match(CATCH, /replyOutcome:/);
});

test("a fallback is not the agent resolving anything", () => {
  // 'unresolved' has been in the ResolvedBy vocabulary since the schema was
  // written and nothing had ever written it. Recording a fallback as 'ai_agent'
  // would be the same lie the missing row told, in a row that exists.
  assert.match(CATCH, /resolvedBy: "unresolved"/);

  // And it must not claim tokens it did not spend.
  assert.match(CATCH, /inputTokens: 0/);
  assert.match(CATCH, /outputTokens: 0/);
});

test("three outcomes, because three different things happen to a customer", () => {
  // fallback         — a worse answer reached them
  // none             — NOTHING reached them
  // agent_unrecorded — a real reply reached them and the bookkeeping threw
  //
  // Collapsing the first two would say a customer got a degraded answer when
  // they got silence, which is the difference between an inconvenience and an
  // abandoned conversation.
  assert.match(CATCH, /"agent_unrecorded" as const/);
  assert.match(CATCH, /"fallback" as const/);
  assert.match(CATCH, /"none" as const/);

  // 'none' is only reachable because the fallback sender reports back rather
  // than only logging. It used to return void, so "the customer received
  // nothing" existed solely as a log line — on a box whose logs were erased on
  // every deploy.
  assert.match(PROCESSOR, /async function sendFallbackBestEffort\([\s\S]*?\): Promise<boolean>/);
  assert.match(PROCESSOR, /reached = await sendFallbackBestEffort\(/);
});

test("a zero that is a measurement is kept apart from a zero that is a loss", () => {
  // On the `agent_unrecorded` path a reply DID go out and cost tokens; the
  // count was lost with the exception. The row exists to keep the conversation
  // in the denominator, and the outcome value is what says its zeros are not
  // a measurement — the alternative being a silent token undercount that looks
  // exactly like a cheap reply.
  assert.match(MIGRATION, /agent_unrecorded/);
  assert.match(
    MIGRATION,
    /token counts are not the reply's/,
    "the migration must say what the zeros on that row mean"
  );
});

test("the intent still classifies when the reply fails", () => {
  // Not incidental. Intent coverage is the load-bearing input to F5, F10 and
  // F11, and until now a failed reply contributed nothing to it — so an outage
  // quietly starved the three features that grow with coverage.
  assert.match(CATCH, /intent: classifyIntent\(\{ text: message\.text\?\.body \}\)\.intent/);

  // From the text ALONE. There are no tool calls on this path — the model never
  // ran — and passing an empty list would be asserting that it ran and called
  // nothing.
  assert.ok(!/classifyIntent\(\{ text: message\.text\?\.body, toolCalls/.test(CATCH));
});

test("the successful path says so explicitly rather than by omission", () => {
  // Every existing row means 'agent'; the value is written from now on so the
  // column's meaning does not depend on which rows happen to be missing.
  assert.match(PROCESSOR, /replyOutcome: "agent" as const/);
  assert.match(METRICS, /reply_outcome\)/);
  assert.match(METRICS, /input\.replyOutcome \?\? null/);
});

test("history is left honestly unknown rather than half-filled", () => {
  // The 12 existing rows were all agent replies and could safely be backfilled.
  // The 4 fallbacks cannot be reconstructed as rows at all — so a column that
  // is complete for the successes and empty for the failures would be more
  // dangerous than one that is null for both.
  assert.match(MIGRATION, /add column if not exists reply_outcome text/);
  assert.match(MIGRATION, /reply_outcome is null/);
  assert.ok(
    !/^\s*update conversation_metrics/im.test(MIGRATION),
    "no backfill: inventing the successes while the failures stay missing is worse than null"
  );
});

test("the alarm that was missing both times this actually happened", () => {
  const operator = OPERATORS.slice(
    OPERATORS.indexOf("const agentUnavailable"),
    OPERATORS.indexOf("export const OPERATORS")
  );

  // preflightModels() catches a broken model at worker BOOT, which is the wrong
  // moment: both real outages began while the worker was already running.
  assert.match(operator, /reply_outcome = 'fallback'/);
  assert.match(operator, /reply_outcome = 'none'/);

  // Any 'none' is urgent — a customer received nothing at all. One fallback is
  // a blip (a timeout, a rate limit); three in six hours is a provider.
  assert.match(operator, /const silent = none > 0/);
  assert.match(operator, /FALLBACK_URGENT_AT/);
  assert.match(operator, /severity: silent \|\| fallback >= FALLBACK_URGENT_AT/);

  // Registered, or it is a feature that reports itself as built and never runs.
  assert.match(OPERATORS, /^\s*agentUnavailable,\s*$/m);
});

test("Postgres is made to accept every value the application can write", () => {
  // The check constraint lives in the database. A value the application writes
  // and Postgres refuses would surface as a metric row silently missing — the
  // exact defect 049 exists to end, reintroduced one layer down. Nothing in
  // this suite executes SQL, so schema-check has to.
  assert.match(SCHEMA_CHECK, /\["fallback", "none", "agent_unrecorded"\] as const/);
});
