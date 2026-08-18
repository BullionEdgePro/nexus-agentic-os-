// The page said "10 working days". The agent said "5-10 working days".
//
// Found on 2026-08-18 in the first grounded reply juris-prime has ever been
// observed to produce. Retrieval was correct — 0.78 similarity, the right URL —
// and the draft then narrowed the source's figure and added a UAE Embassy step
// the page does not list for UK certificates.
//
// Nothing was fabricated in the usual sense: every word came from a grounded
// reply about the right subject. What went wrong is narrower and far more
// common — a figure was made MORE PRECISE and more favourable than its source.
// For a law firm quoting a timeline, that is the difference between an answer
// and a promise.
//
// The governance judge caught it (medium, which escalates on the strict tier),
// so no customer was misled. But an agent whose every grounded answer escalates
// is an agent that never answers, and the fix belongs upstream of the judge
// rather than in a stricter judge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { searchKnowledgeTool } from "@nexus/agents";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const TOOL = read("packages", "agents", "src", "tools", "knowledge.ts");

test("a grounded result carries the rule that makes it grounded", () => {
  // "Answer ONLY from the excerpts returned" has been in the tool description
  // since the tool existed, and it was not enough: the model obeyed it and
  // still improved a number. The constraint has to say what obeying means for
  // figures specifically.
  assert.match(TOOL, /constraints:/);
  assert.match(TOOL, /Quote figures exactly as the excerpt states them/);

  // The four ways the observed failure could have happened, named individually
  // rather than as "do not make things up" — which the model was already
  // following.
  for (const rule of [/narrow a range/, /add a lower/, /combine numbers/, /convert one unit/]) {
    assert.match(TOOL, rule);
  }

  // A qualification is part of the figure. "10 working days, depending on the
  // issuing authority" becomes a promise the moment the tail is dropped.
  assert.match(TOOL, /carry\s*"?\s*\+?\s*"?the qualification with it/);
});

test("the constraint rides on the hit, not on the tool description", () => {
  // The description is read once when the tool list is built. The constraint
  // has to be in front of the model at the moment it is holding the passages,
  // which is the moment it decides what to say about them.
  const hit = TOOL.slice(TOOL.indexOf('outcome: "hit" as const'), TOOL.indexOf("results: hits.map"));
  assert.match(hit, /constraints:/);
});

test("it is platform-level, and no tenant's own wording is touched", () => {
  // This is not a business decision about how a firm talks to its customers —
  // it is the rule that makes "answer only from the excerpts" mean what it
  // says. Editing a business's system prompt to fix it would be the platform
  // rewriting a law firm's voice on its behalf.
  assert.match(TOOL, /no tenant's system prompt is edited/);
});

test("the degraded path keeps its own, stricter instruction", () => {
  // Keyword matches get a different note — use one only if it plainly answers
  // the question — and that must not be quietly replaced by the softer figures
  // rule when both are in play.
  const degraded = TOOL.slice(TOOL.indexOf('outcome: "degraded" as const'));
  assert.match(degraded, /found by matching WORDS/);
  assert.match(degraded, /ignore any that merely share a word/);
});

test("a miss still returns nothing to quote from", async () => {
  // The constraint exists only where there is something to constrain. A miss
  // carrying rules about figures would be instructions about excerpts that do
  // not exist.
  const out = await searchKnowledgeTool.handler({ query: "" }, { organizationId: "org" });
  assert.equal(out.found, false);
  assert.equal(out.constraints, undefined);
});
