// ABR's agent knew five passages while nine pages of practice-area content sat
// one link from its home page. Nothing reported it: broken-knowledge watches
// sources that FAIL, and a business with too few working sources has nothing
// wrong with it in that sense. It was found by counting rows by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const INGEST = read("apps", "api", "src", "scripts", "ingest-site.ts");

test("the operator is registered, or it is dead code with tests", () => {
  // Two operators have been written in this repo and one of them was nearly
  // shipped unregistered. The list is the only thing that runs them.
  const list = OPERATORS.slice(OPERATORS.indexOf("export const OPERATORS"));
  assert.match(list, /thinKnowledge,/);
});

test("nothing at all is reported differently from not enough", () => {
  // A business with zero indexed passages almost always means the onboarding
  // step was skipped. A business with nine means a thin website. Same reading
  // for both would make the urgent case unfindable among the warnings.
  assert.match(OPERATORS, /chunks === 0 \? \("urgent" as const\) : \("warn" as const\)/);
  assert.match(OPERATORS, /This agent has no knowledge at all/);
});

test("failed sources are excluded from the count", () => {
  // Otherwise a business whose every source failed to index looks well supplied
  // — and broken-knowledge, which does report that, would be the only warning,
  // understating a total outage as a handful of fetch errors.
  assert.match(OPERATORS, /and s\.status <> 'failed'/);
});

test("one finding per business, on a constant fingerprint", () => {
  // There is one action to take. A fingerprint per missing page would produce a
  // list that grows as the problem is understood better, and reconciliation
  // keys on this — a varying fingerprint accumulates rows instead of updating.
  assert.match(OPERATORS, /fingerprint: "knowledge-volume"/);
});

test("the threshold is stated as a floor, not a quality score", () => {
  // A hundred passages of marketing copy answer less than twenty of real FAQ.
  // The comment says so, because a number in code invites being read as a
  // measurement of something it does not measure.
  assert.match(OPERATORS, /const THIN_KNOWLEDGE_CHUNKS = 15;/);
  assert.match(OPERATORS, /not answer quality/i);
});

// ============================================================
// The instance that prompted it
// ============================================================

test("abshlaw.com is no longer described as one page", () => {
  // The claim was plausible, written once, never rechecked, and decided how
  // much a litigation firm's agent was allowed to know. All ten pages return
  // 200; each practice-area page carries roughly a thousand words.
  const code = INGEST.replace(/\/\*[\s\S]*?\*\//g, " ");
  const abr = code.slice(code.indexOf("abr: {"), code.indexOf("atif-ali-production"));
  for (const page of [
    "litigation.html",
    "criminal-law.html",
    "corporate-law.html",
    "family-law.html",
    "property-law.html",
    "maritime-law.html",
    "construction-law.html",
    "intellectual-property.html",
    "our-expertise.html",
    "overview.html",
  ]) {
    assert.ok(abr.includes(page), `ABR must index ${page}`);
  }
  console.log("PASS: an agent that knows nothing is not a healthy agent");
});
