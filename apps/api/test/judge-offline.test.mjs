// The governance judge had been dead in production and nothing said so.
//
// The Anthropic key has no credit, so every judge call threw and
// evaluateHallucinationRisk returned "medium". That is not a verdict, it is the
// absence of one, and no consumer can tell the difference — the deck shows
// "hallucination risk medium", which reads exactly like a judge that ran.
//
// Found by generating one reply per business and reading the verdict printed
// beside it, which is the first time anybody had looked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JUDGE_UNAVAILABLE } from "@nexus/governance";
import { shouldEscalateReply } from "@nexus/governance";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const HALLUCINATION = read("packages", "governance", "src", "hallucination.ts");

test("a failed judge writes a marker something can match on", () => {
  // Matched via the exported constant rather than a re-typed string literal: an
  // operator searching for prose a developer might reword is an operator that
  // goes quiet the day somebody improves the wording.
  assert.ok(JUDGE_UNAVAILABLE.length > 10);
  assert.match(HALLUCINATION, /notes: `\$\{JUDGE_UNAVAILABLE\}/);
  assert.match(OPERATORS, /JUDGE_UNAVAILABLE/);
  assert.ok(
    !OPERATORS.includes('"Judge call failed'),
    "the operator must not hardcode the message it is looking for"
  );
});

test("the verdict stays medium, because medium is the safe reading", () => {
  // Tempting to invent an "unknown" risk level. That pushes a new state into
  // every consumer — the policy, the deck, the rollups — and the migration is
  // the point at which one of them treats the unfamiliar value as "fine".
  // Medium already escalates for every strict tenant.
  const failed = HALLUCINATION.slice(HALLUCINATION.indexOf("} catch (err) {"));
  assert.match(failed, /risk: "medium"/);
});

test("what a stuck medium actually does to each business", () => {
  // This is the consequence, asserted rather than described. It is why the
  // operator is urgent rather than a warning.
  const stuck = { piiFlagged: false, hallucinationRisk: "medium" };

  // The three that are not on the tolerant allowlist escalate EVERY reply —
  // and with an empty rota the customer gets the no-staff fallback instead of
  // the grounded answer the agent actually wrote.
  for (const slug of ["juris-prime", "juris-prime-legal", "abr"]) {
    assert.equal(shouldEscalateReply(stuck, slug), true, slug);
  }

  // The two tolerant ones send everything, checked by nothing.
  for (const slug of ["zipicka", "sfs-international"]) {
    assert.equal(shouldEscalateReply(stuck, slug), false, slug);
  }
});

test("the operator is registered, and calls no model", () => {
  const list = OPERATORS.slice(OPERATORS.indexOf("export const OPERATORS"));
  assert.match(list, /judgeOffline,/);

  // It has to work on the day the models are the broken thing. An operator that
  // needed a model call to report that model calls are failing would be silent
  // exactly when it matters.
  const code = OPERATORS.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const forbidden of [/generateContent/, /messages\.create/, /callModel/]) {
    assert.ok(!forbidden.test(code), `operators must not infer: ${forbidden}`);
  }
});

test("it is urgent whenever it happens at all, not above some rate", () => {
  // A judge that fails intermittently is not a degraded judge — it is one whose
  // verdicts cannot be trusted, because a medium from a working call and a
  // medium from a failed one are the same stored row.
  const branch = OPERATORS.slice(OPERATORS.indexOf("const judgeOffline"));
  assert.match(branch, /if \(failed === 0\) return \[\];/);
  assert.match(branch, /severity: "urgent" as const/);
  console.log("PASS: a default is not a verdict");
});
