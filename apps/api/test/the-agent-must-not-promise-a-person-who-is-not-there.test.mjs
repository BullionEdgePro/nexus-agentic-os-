// "I'm flagging this as urgent so the firm is alerted immediately."
//
// Nobody would have been alerted.
//
// FOUND BY READING WHAT THE AGENT ACTUALLY SAYS. dry-run-reply.ts exists to
// answer the question retrieval-check cannot — given the right page, what does
// the agent WRITE — and it is deliberately not a gate, because its output is
// prose a person has to read. On 2026-08-22 somebody finally read it.
//
// Put to ABR's live agent: "My brother has been arrested in Dubai and we need a
// criminal defence lawyer urgently." It replied that it was flagging the matter
// so the firm would be alerted immediately, then asked for the brother's name,
// where he was being held, and when the arrest happened.
//
// ABR has zero active staff. The reply path reaches flagHandoffBestEffort,
// finds nobody on the rota, logs a warning and returns: no handoff, no inbox
// event, and with OPERATOR_ALERT_WEBHOOK_URL unset, no notification of any
// kind. The warning goes to a container log erased on the next deploy. A person
// whose brother is in police custody would have stopped looking for help.
//
// The instruction is the tenant's own: ABR's system prompt says of an arrest,
// "tell them the firm will be alerted immediately and escalate". The prompt is
// right about what the firm wants and cannot know whether anybody is on the
// rota at 2am.
//
// AND THE GOVERNANCE JUDGE PASSED IT, correctly and uselessly. It checks claims
// against the RETRIEVED KNOWLEDGE; "the firm is alerted" is a claim about the
// platform, which appears in no passage it reads. A judge scoped to one kind of
// truth says nothing about the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const HANDOVER = read("packages", "agents", "src", "handover.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");

function note() {
  const from = HANDOVER.indexOf("export function describeNobodyToEscalateTo");
  assert.ok(from > -1, "the note builder is gone");
  return HANDOVER.slice(from, HANDOVER.indexOf("\n}", from));
}

test("the note forbids the specific claim, by the words the agent would use", () => {
  // Not "do not over-promise" — a general caution is one a model can satisfy
  // while still writing the sentence. The banned verbs are named.
  const body = note();
  for (const verb of ["alerted", "notified", "flagged", "told"]) {
    assert.ok(body.includes(verb), `the note does not rule out "${verb}"`);
  }
  assert.match(body, /No notification will be sent/);
});

test("it says what IS true, not only what is false", () => {
  // Somebody in an emergency needs somewhere to go. A note that only removes
  // the promise leaves them with less than they had.
  const body = note();
  assert.match(body, /You may still take their details/);
  assert.match(body, /direct contact details/);
  assert.match(body, /use it now rather than wait/);
});

test("it invents no contact detail, because there is none to invent", () => {
  // The first version took an office number. `Organization` carries an id, a
  // slug, a name, two Meta ids and a timezone — nothing dialable. That absence
  // is the same one ABR's `no_one_available` phrase is blocked on.
  assert.match(HANDOVER, /export function describeNobodyToEscalateTo\(\): string/);
  const body = note();
  assert.ok(!/officeHint/.test(body), "it is threading a value the platform does not hold");
});

test("it asks the SAME question the escalation asks", () => {
  // hasActiveEmployees would be the wrong one: a firm whose staff are all
  // off-shift still cannot take a handover tonight, and flagHandoffBestEffort
  // checks presence rather than employment. If these two diverge, the agent's
  // words and the platform's behaviour diverge with them — which is the whole
  // defect, reintroduced one layer up.
  assert.match(PROCESSOR, /const canPromiseAPerson = await hasStaffOnShift\(serving\.id\)/);
  assert.match(PROCESSOR, /hasStaffOnShift\(answering\)/, "the escalation no longer checks presence");
});

test("the widening is left where it already is", () => {
  // I wrapped this in withServingTenant on the first pass, by matching the
  // shape of the defect class this codebase has met ten times. hasStaffOnShift
  // ALREADY widens itself -- the Scoped-inner pattern -- and a withTenant
  // nested in a withTenant deliberately reuses the outer context, so the
  // wrapper did nothing except move the .catch off the call it was guarding.
  // An existing test caught it, which is the system working.
  const call = PROCESSOR.slice(
    PROCESSOR.indexOf("const canPromiseAPerson"),
    PROCESSOR.indexOf("const notes = [")
  );
  assert.ok(!/withServingTenant/.test(call), "the redundant wrapper is back");

  // And the widening must still be where it moved to.
  const availability = read("apps", "api", "src", "services", "availability.ts");
  const fn = availability.slice(availability.indexOf("export async function hasStaffOnShift"));
  assert.match(
    fn.slice(0, 400),
    /withServingTenant/,
    "hasStaffOnShift stopped widening itself, so the call site must start"
  );
});

test("a failed check assumes somebody IS there", () => {
  // Same direction as flagHandoffBestEffort's own fallback. A transient
  // database blip must not make five agents start telling customers there is
  // nobody to help them.
  const call = PROCESSOR.slice(
    PROCESSOR.indexOf("const canPromiseAPerson"),
    PROCESSOR.indexOf("const notes = [")
  );
  assert.match(call, /\.catch\(\(\) => true\)/);
});

test("the note sits with the instructions, not with the facts", () => {
  // The other notes are context to hold in mind. This one, like the procedure,
  // is an order about what to do — and it overrides an instruction the system
  // prompt gives unconditionally, so it must not be buried above three
  // paragraphs of memory.
  const block = PROCESSOR.slice(PROCESSOR.indexOf("const notes = ["));
  const list = block.slice(0, block.indexOf("].filter"));
  assert.ok(
    list.indexOf("describeNobodyToEscalateTo") > list.indexOf("bookedNote"),
    "the note has drifted above the facts it is meant to follow"
  );
  assert.ok(
    list.indexOf("describeNobodyToEscalateTo") < list.indexOf("procedure?.note"),
    "the procedure must stay nearest the customer's message"
  );
});

test("one staff answer per reply, not two", () => {
  // The escalation path asked hasStaffOnShift for the SAME business in the SAME
  // message, to decide whether to send the no_one_available phrase. That is a
  // second round trip and, worse, a second source of truth: a shift boundary
  // falling between the two calls would let the agent be told it may promise a
  // colleague while the line below decides there is nobody — in one reply.
  assert.match(PROCESSOR, /const canHandOver = shouldEscalate \? canPromiseAPerson : false;/);

  // Still guarded on shouldEscalate, which is what keeps the ordinary path from
  // resolving a phrase it will not send.
  const line = PROCESSOR.slice(PROCESSOR.indexOf("const canHandOver"));
  assert.match(line.slice(0, 120), /shouldEscalate \?/);
});

test("the two moments send different wording", () => {
  // handing_over is "a colleague is coming". no_one_available is "nobody is,
  // here is how to reach us". Collapsing them would put the wrong one in front
  // of somebody at the worst moment.
  assert.match(PROCESSOR, /resolvePhrase\(serving\.id, "handing_over", FALLBACK_REPLY\)/);
  assert.match(PROCESSOR, /resolvePhrase\(serving\.id, "no_one_available", FALLBACK_REPLY_NO_STAFF\)/);
});
