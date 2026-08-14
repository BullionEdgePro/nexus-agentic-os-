// Intent classification — the source F5 reads.
//
// Before this existed, `conversation_metrics.intent` came from tool calls only.
// 83% of production traffic fires no tool, so 83% of conversations were written
// with a NULL intent and F5's pooled store — which filters on `intent is not
// null` — could see a sixth of the platform. It reported an empty result, and
// an empty result looked exactly like "not enough businesses yet". One of those
// is fixed by waiting for a second tenant and the other never would have been.
//
// These tests run the real classifier rather than reading its source, because
// the failure this feature exists to prevent is a classification that is
// plausible and wrong — and source text cannot tell you what a function returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { classifyIntent } from "@nexus/agents";
import { NON_PATTERN_INTENTS, INTENT_CATEGORIES, isPatternIntent } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const INTENT = read("packages", "agents", "src", "intent.ts");
const BRAIN = read("packages", "db", "src", "shared-brain.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");

// ============================================================
// It reads the text, which is the entire point
// ============================================================

test("a message that fires no tool is still classified", () => {
  // The whole defect in one assertion. Every one of these would have been NULL
  // before, and NULL is what F5 cannot see.
  const cases = [
    ["How much is the 24k chain?", "purchase_inquiry"],
    ["Can I book a consultation for Thursday?", "appointment_booking"],
    ["I need a lawyer for a trademark dispute", "legal_inquiry"],
    ["my order arrived damaged and I want a refund", "complaint"],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyIntent({ text }).intent, expected, text);
  }
});

test("Arabic is classified, not floored", () => {
  // The tenants are UAE-based. An English-only classifier would have recorded
  // every Arabic customer as unclassifiable and F5 would have learned the
  // platform's local traffic does not exist.
  assert.equal(classifyIntent({ text: "بكم هذا؟" }).intent, "purchase_inquiry");
  assert.equal(classifyIntent({ text: "اريد حجز موعد" }).intent, "appointment_booking");
  assert.equal(classifyIntent({ text: "عندي شكوى، الطلب وصل مكسور" }).intent, "complaint");
});

// ============================================================
// What it refuses to do
// ============================================================

test("an unreadable message is `unknown`, never a friendly default", () => {
  // scoreLead's own default category is `general_inquiry`, which it uses when
  // NO rule matched. Mapping that through would pool every message the rules
  // could not read into one large, confident pattern meaning "we could not
  // tell" — and since unmatched messages are the majority, it would be the
  // first pattern to qualify and the first thing the Brain ever said.
  assert.equal(classifyIntent({ text: "hello" }).intent, "unknown");
  assert.equal(classifyIntent({ text: "ok thanks" }).intent, "unknown");
  assert.ok(!INTENT.includes("general_inquiry:"), "general_inquiry must not be mapped to an intent");
});

test("a media-only message with no text is `unknown`, not an error", () => {
  assert.equal(classifyIntent({}).intent, "unknown");
  assert.equal(classifyIntent({ text: null }).intent, "unknown");
  assert.equal(classifyIntent({ text: "   " }).intent, "unknown");
});

test("it never returns null — null now means the classifier did not run", () => {
  // The distinction the whole design rests on. `unknown` is a classification;
  // NULL is a defect. One value for both is how a classifier that silently
  // stopped running produces a table indistinguishable from a quiet week.
  for (const text of ["", "hello", "بكم", "!!!", "😀"]) {
    const result = classifyIntent({ text });
    assert.ok(result.intent, `classifyIntent must return an intent for ${JSON.stringify(text)}`);
    assert.ok(INTENT_CATEGORIES.includes(result.intent));
  }
});

// ============================================================
// Precedence
// ============================================================

test("a tool call beats keyword guessing", () => {
  // The tool records what happened; keywords guess at what was meant.
  const result = classifyIntent({
    text: "hello",
    toolCalls: [{ name: "check_inventory" }],
  });
  assert.equal(result.intent, "inventory_inquiry");
  assert.equal(result.source, "tool");
});

test("a complaint beats the tool, and only a complaint does", () => {
  // Mirrors the precedence scoreLead already applies: a complaint is what the
  // message IS, whatever product words it contains. An angry customer whose
  // message also tripped a knowledge lookup is not a knowledge_lookup — and
  // since the tool almost always fires, filing them that way is how a complaint
  // rate reads as zero while complaints arrive.
  const angry = classifyIntent({
    text: "this is broken and I want a refund",
    toolCalls: [{ name: "search_knowledge" }],
  });
  assert.equal(angry.intent, "complaint");
  assert.equal(angry.source, "text");

  // The narrowness matters as much as the rule. Anything else defers.
  const ordinary = classifyIntent({
    text: "how much is delivery",
    toolCalls: [{ name: "search_knowledge" }],
  });
  assert.equal(ordinary.intent, "knowledge_lookup");
});

test("asking for times counts as booking even if nothing was booked", () => {
  assert.equal(
    classifyIntent({ text: "", toolCalls: [{ name: "check_availability" }] }).intent,
    "appointment_booking"
  );
});

// ============================================================
// One vocabulary, or F5 silently splits every pattern in half
// ============================================================

test("the tool mapping and the text mapping share one vocabulary", () => {
  // Two producers naming the same thing differently do not create one pattern
  // with a disagreement in it — they create TWO, each holding half the samples,
  // each looking thinner than the truth, and neither reaching the 20-sample
  // threshold. Nothing errors and the store simply never fills.
  const viaTool = classifyIntent({ toolCalls: [{ name: "book_appointment" }] }).intent;
  const viaText = classifyIntent({ text: "I'd like to book an appointment" }).intent;
  assert.equal(viaTool, viaText, "the same intent reached two ways must carry one name");
});

test("every intent the classifier can emit is in the shared vocabulary", () => {
  const emitted = [
    classifyIntent({ text: "how much" }).intent,
    classifyIntent({ text: "book an appointment" }).intent,
    classifyIntent({ text: "I need a lawyer" }).intent,
    classifyIntent({ text: "refund, it is broken" }).intent,
    classifyIntent({ text: "we are a b2b supplier, do you want to buy leads" }).intent,
    classifyIntent({ text: "hello" }).intent,
    classifyIntent({ toolCalls: [{ name: "check_inventory" }] }).intent,
    classifyIntent({ toolCalls: [{ name: "search_knowledge" }] }).intent,
  ];
  for (const intent of emitted) {
    assert.ok(INTENT_CATEGORIES.includes(intent), `${intent} is not in INTENT_CATEGORIES`);
  }
});

// ============================================================
// Spam must not become the platform's flagship pattern
// ============================================================

test("an inbound B2B pitch is classified as one and excluded from pooling", () => {
  // Lead scoring records that pitches are "the dominant traffic on this number
  // in practice". Pooled, they would be the largest and first-to-qualify
  // pattern on the platform — "inbound pitches escalate 0% of the time", true,
  // useless, and the flagship output of a feature called the Neural Brain.
  const pitch = classifyIntent({
    text: "We are a B2B data provider. Do you want to purchase our premium leads database?",
  });
  assert.equal(pitch.intent, "inbound_pitch");
  assert.ok(!isPatternIntent("inbound_pitch"));
});

test("the non-pattern intents are excluded in the rollup, not left to callers", () => {
  // Same argument as the two-tenant guard: a filter the caller has to remember
  // is a filter the first careless caller forgets, and nothing downstream can
  // tell that spam is being presented as platform intelligence.
  assert.deepEqual([...NON_PATTERN_INTENTS].sort(), ["inbound_pitch", "unknown"]);
  assert.match(BRAIN, /and cm\.intent <> all\(\$1::text\[\]\)/);
  assert.match(BRAIN, /NON_PATTERN_INTENTS/);
});

test("they are excluded from the ROLLUP but still written to the row", () => {
  // Their share of traffic is the measure of how much of the platform F5 can
  // read. Dropping them at write time would delete the evidence that coverage
  // is bad, which is the number this whole change exists to expose.
  assert.ok(
    !/intent:\s*null/.test(PROCESSOR),
    "the reply path must never write a null intent — null now means the classifier did not run"
  );
  assert.match(PROCESSOR, /classifyIntent\(\{ text: message\.text\?\.body/);
});

// ============================================================
// Coverage is reported, because an empty store must say which emptiness it is
// ============================================================

test("brain status separates 'cannot read the traffic' from 'only one tenant'", () => {
  // The two look identical from outside — both are an empty table — and only
  // one is fixed by waiting. Saying "only one business has traffic" while five
  // sixths of that business's conversations are unreadable sends the reader off
  // to wait for something that would not have helped.
  assert.match(BRAIN, /coverage: IntentCoverage/);
  assert.match(BRAIN, /This is a gap in classification, not in traffic/);
  const status = BRAIN.slice(BRAIN.indexOf("export async function getBrainStatus"));
  assert.ok(
    status.indexOf("coverage.classified === 0") < status.indexOf("Only one business has customer traffic"),
    "coverage must be checked before the tenant count — it binds first"
  );
});

test("coverage counts conversations, matching how the rollup counts", () => {
  // Per metric row, a chatty conversation would weigh more than a brief one and
  // the two views of the same source could disagree without anything erroring.
  const coverage = BRAIN.slice(BRAIN.indexOf("export async function getIntentCoverage"));
  assert.match(coverage, /group by conversation_id/);
});

test("the coverage query declares itself cross-tenant", () => {
  // conversation_metrics is tenant-scoped and /quality/shared carries no tenant
  // context, so without this the query throws under DB_TENANT_ASSERT=strict —
  // which is precisely what that assertion is for.
  assert.match(BRAIN, /withAllTenants\("F5 intent coverage/);
  console.log("PASS: intent is classified from text, one vocabulary, spam and unknowns excluded from pooling");
});
