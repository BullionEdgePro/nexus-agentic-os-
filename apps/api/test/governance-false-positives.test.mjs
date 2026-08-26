// The governance judge came back to life on 2026-08-13 and immediately blocked
// two correct answers. Both were the checks working exactly as written, on
// inputs that were missing the one fact that made the reply legitimate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanForPii, shouldEscalateReply } from "@nexus/governance";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

// ============================================================
// 1. A business quoting its own published contact details
// ============================================================

// Verbatim from Zipicka's refund-policy page, which is where the agent read it.
const PUBLISHED = `To start a return, email marketing@zipicka.com and we will send
you a return label with instructions. Returns are accepted within 30 days.`;

const REPLY = `You have 30 days after receiving your item to request a return.
To start the return, just email marketing@zipicka.com and they'll send you a
return label.`;

test("a business's own published address is not a leak", () => {
  // Without the published context this is a PII match, and a PII match
  // escalates for EVERY tenant — tolerant ones included. Zipicka's best answer
  // would have been withheld from the customer and handed to a person, for
  // quoting the business's own public inbox back to them.
  assert.equal(scanForPii(REPLY).length, 1, "still a match with no context");
  assert.deepEqual(scanForPii(REPLY, { publishedContext: PUBLISHED }), []);
});

test("somebody else's address in the same reply is still caught", () => {
  // The exemption must be per-value, not a blanket "there was context, skip the
  // scan". A reply that quotes the business inbox AND leaks a customer's
  // address has to fail.
  const leaky = `${REPLY}\n\nI can see your order under jane.doe@example.com.`;
  const matches = scanForPii(leaky, { publishedContext: PUBLISHED });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, "email");
});

test("conversation history is deliberately not a source of exemption", () => {
  // It can carry a third party's details that the customer typed in, and
  // repeating those back out is exactly the leak this scan exists to catch.
  // Only the retrieved knowledge base — the business's own published material —
  // exempts anything.
  const governance = read("packages", "governance", "src", "index.ts");
  assert.match(governance, /publishedContext: input\.ragContext/);
  const code = governance.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.ok(
    !/publishedContext:\s*input\.conversationHistory/.test(code),
    "history must never exempt a match"
  );
});

test("the raw value never leaves the scanner", () => {
  // PiiMatch carries the redacted form only, and these matches are written into
  // evaluation notes that get stored and displayed. The comparison needs the
  // raw string, so it happens inside scanForPii rather than at the call site.
  const matches = scanForPii(REPLY);
  assert.deepEqual(Object.keys(matches[0]).sort(), ["redacted", "type"]);
  assert.ok(!JSON.stringify(matches).includes("marketing@zipicka.com"));
});

// ============================================================
// 2. An agent naming its own company
// ============================================================

test("the judge is told who is speaking", () => {
  // Juris Prime Legal's agent scored HIGH for "references 'Juris Prime Legal'
  // as a service provider ... not mentioned anywhere in the conversation
  // history or retrieved context". The judge was right on its own terms and had
  // never been told whose reply it was auditing.
  const hallucination = read("packages", "governance", "src", "hallucination.ts");
  assert.match(hallucination, /businessName\?: string;/);
  assert.match(hallucination, /input\.businessName/);
  assert.match(hallucination, /is NOT a hallucination — it is the speaker/);
});

test("the live pipeline passes the grounding it judged without", () => {
  // The processor sent only the draft and the history. Every fact correctly
  // taken from the knowledge base looked unsupported, biasing the judge toward
  // "high" on precisely the replies that did their job.
  const processor = read("apps", "api", "src", "queue", "processor.ts");
  assert.match(processor, /call\.name === "search_knowledge"/);
  assert.match(processor, /ragContext: retrieved \|\| undefined/);
  assert.match(processor, /businessName: serving\.name/);
  // `serving`, not the number owner — on a shared number the judge must be told
  // which business actually answered.
  const code = processor.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  assert.ok(!/businessName: organization\.name/.test(code), "must be the routed tenant");
});

test("what each verdict still does, so a fix here cannot quietly widen it", () => {
  // These consequences are why both false positives mattered rather than being
  // cosmetic. Unchanged by this work — asserted so that stays true.
  assert.equal(shouldEscalateReply({ piiFlagged: true, hallucinationRisk: "low" }, "zipicka"), true);
  assert.equal(shouldEscalateReply({ piiFlagged: false, hallucinationRisk: "high" }, "zipicka"), true);
  assert.equal(
    shouldEscalateReply({ piiFlagged: false, hallucinationRisk: "medium" }, "juris-prime-legal"),
    true
  );
  console.log("PASS: the checks were right; the inputs were missing a fact");
});

// ============================================================
// 3. A business quoting its own ADDRESS
// ============================================================
//
// The third of the same kind, found 2026-08-26 in the first Arabic dry run.
// ABR's reply to "my brother has been arrested, we need a criminal lawyer
// urgently" scored HIGH -- verbatim: "asserts a specific office address
// (building name, location, district in Dubai, and hours) that does not
// appear anywhere in the retrieved knowledge base".
//
// The identical ENGLISH scenario scored LOW an hour earlier, because
// retrieval happened to return a page carrying the address that time. The
// verdict turned on which chunks came back, not on whether the reply was
// true -- so the same sentence was a hallucination on Tuesday and a fact on
// Monday.

test("the judge is given what the business says about itself", () => {
  const HALLUCINATION = read("packages", "governance", "src", "hallucination.ts");

  // A plain string, not a pattern. The regex written here first arrived with
  // its escape eaten, so `businessFacts?:` became "businessFact" plus an
  // optional "s" — a pattern that could never match the literal question mark
  // in the source. Twelfth instance of that on this repository's register, and
  // the argument for plain strings wherever one will do.
  assert.ok(
    HALLUCINATION.includes("businessFacts?: string;"),
    "the judge cannot see the business's own standing instructions"
  );
  // And it is put in the prompt as a SOURCE, not merely accepted as a field.
  assert.ok(
    HALLUCINATION.includes("input.businessFacts"),
    "businessFacts is accepted and never shown to the judge"
  );
  assert.ok(
    HALLUCINATION.includes("Treat these as verified for its identity, contact"),
    "the judge is not told these are the speaker's own verified statements"
  );
});

test("the reply pipeline and the dry run give the judge the same sources", () => {
  // A dry run that grades more harshly than production is a dry run that
  // sends somebody hunting a defect which does not exist -- and one that
  // grades more leniently hides the ones that do.
  const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
  const DRY_RUN = read("apps", "api", "src", "scripts", "dry-run-reply.ts");
  for (const [name, source] of [["the reply pipeline", PROCESSOR], ["the dry run", DRY_RUN]]) {
    assert.ok(
      source.includes("businessFacts: agent.config.systemPrompt"),
      `${name} does not give the judge the business's own instructions`
    );
    assert.ok(source.includes("businessName:"), `${name} does not say who is speaking`);
  }
});

// Worth recording and NOT worth asserting: the PII half of governance learned
// in August that a business's own published contact details are not a leak,
// and the hallucination half never learned it — so one governance check
// treated the firm's phone number as legitimate while the other treated it as
// invented, in the same reply.
//
// This was written as a test first, checking that the sentence recording that
// lesson still appears in index.ts. `a-claim-satisfied-by-prose` caught it
// within the minute: a phrase that exists only in a comment is an assertion
// green on prose. The behaviour it gestures at is already proved by the first
// test in this file.
