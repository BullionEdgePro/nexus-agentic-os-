/**
 * Nobody could opt out, and nothing said so.
 *
 * ============================================================
 * THE FOURTH ONE OF THESE
 * ============================================================
 *
 * `contacts.reengagement_opted_out` has existed since migration 035. Two places
 * READ it. Nothing had ever WRITTEN it. Every customer on this platform has
 * been unable to opt out since the column was created, and the code around it
 * reads perfectly: the audience query filters on the flag, and the flag is
 * false for everybody.
 *
 * This repository has now found the same shape four times — `delivery_error`
 * written by nothing for two months, `working_hours` with no writer at all,
 * `attempts: 3` configured on a processor that swallowed every error, and this.
 * A column that is read and never written is invisible to every test that
 * checks behaviour, because the behaviour is consistent. It is only visible if
 * something asks whether the write exists.
 *
 * It became urgent rather than merely wrong the moment a MARKETING template was
 * submitted. A promotional message nobody can stop is what produces a spam
 * report, and on this deployment the quality rating a report damages belongs to
 * ONE number that six businesses answer on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { looksLikeAnOptOut, OPT_OUT_BUTTON_LABEL } from "../../../packages/agents/src/opt-out.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const BOOK = read("packages", "db", "src", "client-book.ts");
const PROVISION = read("apps", "api", "src", "scripts", "provision-templates.ts");
const CLIENT = read("apps", "api", "src", "lib", "whatsapp-client.ts");

// ============================================================
// The column now has a writer
// ============================================================

test("something finally sets the flag", () => {
  assert.match(BOOK, /export async function optOutOfReengagement/);
  assert.match(BOOK, /set reengagement_opted_out = true/);
});

test("the writer is actually reached from the reply path", () => {
  // A writer nothing calls is the same defect wearing a different hat.
  assert.match(PROCESSOR, /looksLikeAnOptOut\(text\.body\)/);
  assert.match(PROCESSOR, /optOutOfReengagement\(contactId\)/);
});

// ============================================================
// Narrow, because the wide version removes people who are still talking
// ============================================================

test("a bare stop word opts out", () => {
  for (const text of ["stop", "STOP", "Stop.", "unsubscribe", "Opt out", "remove me"]) {
    assert.equal(looksLikeAnOptOut(text), true, `"${text}" should opt out`);
  }
});

test("the button's own label opts out", () => {
  // A quick reply arrives as an ordinary inbound message carrying exactly the
  // button text, so the two have to agree. If the label is ever reworded and
  // this is not, every button press becomes a normal message the agent answers.
  assert.equal(looksLikeAnOptOut(OPT_OUT_BUTTON_LABEL), true);
});

test("a sentence merely containing stop does NOT opt out", () => {
  // The tempting implementation is text.includes("stop"). It unsubscribes the
  // customer who writes "please stop the delivery, I want to change the
  // address" -- somebody actively transacting, removed from everything, with no
  // way for them or anybody else to find out.
  for (const text of [
    "please stop the delivery, I want to change the address",
    "can you stop sending it to the old address",
    "do you have stop motion toys",
    "where is my order",
  ]) {
    assert.equal(looksLikeAnOptOut(text), false, `"${text}" must NOT opt out`);
  }
});

test("an empty message is not an opt-out", () => {
  assert.equal(looksLikeAnOptOut(""), false);
  assert.equal(looksLikeAnOptOut("   "), false);
});

// ============================================================
// Honoured before everything that can break
// ============================================================

test("the opt-out is handled before routing, retrieval and the model", () => {
  // It has to work on the day all of those are broken, which is exactly the day
  // a frustrated customer sends one.
  const optOut = PROCESSOR.indexOf("looksLikeAnOptOut(text.body)");
  const routing = PROCESSOR.indexOf("const decision = await resolveServingOrganization");
  assert.ok(optOut !== -1 && routing !== -1 && optOut < routing);
});

test("a failed write is not confirmed to the customer", () => {
  // Confirming an opt-out that did not save is a particularly bad lie: the
  // person stops objecting and the messages keep coming.
  const block = PROCESSOR.slice(PROCESSOR.indexOf("looksLikeAnOptOut(text.body)"));
  assert.match(block.slice(0, 2000), /NOT confirmed/);
});

test("a failed opt-out still leaves a trace", () => {
  // Found by the silent-return gate, which is the whole reason that gate
  // exists: a customer who asked to be left alone, was not, and left no record
  // of having asked.
  const block = PROCESSOR.slice(PROCESSOR.indexOf("looksLikeAnOptOut(text.body)"));
  assert.match(block.slice(0, 2000), /recordMetricBestEffort/);
});

// ============================================================
// The template that made this urgent
// ============================================================

test("the marketing template carries the opt-out button", () => {
  assert.match(PROVISION, /category: "MARKETING"/);
  assert.match(PROVISION, /buttons: \[OPT_OUT_BUTTON_LABEL\]/);
});

test("buttons are omitted entirely when there are none", () => {
  // An empty BUTTONS component is a validation error at Meta, not a no-op. The
  // five utility templates already approved must keep submitting exactly what
  // they submitted before.
  assert.match(CLIENT, /spec\.buttons\?\.length/);
});

test("the marketing template claims nothing that could stop being true", () => {
  // The store's own site advertises 20% off and free delivery. A template is
  // approved once and sent for months, and the discount specifically is the
  // claim a previous piece of work was blocked on for not actually existing.
  const spec = PROVISION.slice(PROVISION.indexOf('name: "zipicka_promotions"'));
  const body = spec.slice(0, spec.indexOf("example:"));
  assert.ok(!/%|discount|sale|free delivery|off\b/i.test(body), "an unverifiable claim is in the body");
  // And it names the business, which on a number shared by six is a
  // deliverability decision rather than a branding one.
  assert.match(body, /this is Zipicka/);
});
