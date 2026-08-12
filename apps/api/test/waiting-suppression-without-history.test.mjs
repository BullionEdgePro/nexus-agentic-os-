// The customer-waiting operator's only open urgent finding on production was a
// data broker — "Latest Owner, buyer and investor data available… Do you need a
// database?" — reported as a customer ignored for 260.8 hours.
//
// The pitch suppression was not wrong. It asks whether an `inbound_pitch`
// assessment EXISTS, and for conversations that predate lead scoring being wired
// into the pipeline none does, so the absence read as "not a pitch".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreLead } from "@nexus/leads";

const here = dirname(fileURLToPath(import.meta.url));
const OPERATORS = readFileSync(
  join(here, "..", "src", "services", "operators.ts"),
  "utf8"
);

// The four real messages, copied from production.
const PITCHES = [
  "*Latest Owner, buyer and investor data available* March 2026 updated New Dewa 2026 Jan",
  "Do you need a database?",
  "Hello, we are a pet food manufacturer with over 20 years of experience. We have products in stock",
];
const NOT_A_PITCH = "Hi";

test("the scorer recognises these as pitches, so the fallback has something to say", () => {
  // If this ever stops being true the fix below is inert, and the operator
  // quietly goes back to reporting brokers as ignored customers.
  for (const text of PITCHES) {
    assert.equal(scoreLead({ text }).category, "inbound_pitch", text.slice(0, 40));
  }
  // Scoring the LAST inbound matters: this conversation opened with a wave and
  // a welcome, and only the later message carries the pitch.
  assert.notEqual(scoreLead({ text: NOT_A_PITCH }).category, "inbound_pitch");
});

test("a conversation with no assessment is scored rather than assumed innocent", () => {
  assert.match(OPERATORS, /has_assessment/);
  assert.match(OPERATORS, /if \(row\.has_assessment \|\| !row\.last_body\) return true;/);
  assert.match(
    OPERATORS,
    /scoreLead\(\{ text: row\.last_body \}\)\.category !== "inbound_pitch"/
  );
});

test("a stored assessment still wins over one recomputed from one message", () => {
  // The SQL clause is unchanged and still does the work when history exists. A
  // classification made against the whole conversation at the time beats one
  // derived now from a single message.
  assert.match(OPERATORS, /la\.category = 'inbound_pitch'/);
});

test("the fallback costs no model call", () => {
  // Operators run every ten minutes across every business. That is only
  // affordable because none of them infers. `scoreLead` is pure rules.
  const code = OPERATORS.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  for (const forbidden of [/generateContent/, /anthropic/i, /callModel/]) {
    assert.ok(!forbidden.test(code), `operators must not infer: ${forbidden}`);
  }
  console.log("PASS: no record of a pitch is not evidence of a customer");
});
