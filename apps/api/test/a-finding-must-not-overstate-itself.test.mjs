// A finding that overstates its consequence spends the reader's trust.
//
// booking-without-anyone shipped saying every appointment request "is answered
// with 'nobody is available'". That sentence was written from the operator's
// side of the problem and asserted a customer experience nobody had checked.
//
// Measured in production against the three flagged businesses: findAvailableSlots
// returns ZERO SLOTS for each -- and zero slots is neither an error nor a dead
// end. check_availability turns an empty result into a note instructing the
// model to offer a colleague follow-up. The agent degrades gracefully; the
// finding's stated consequence simply did not happen.
//
// The finding still stands. Its reason moved: an appointment request becomes a
// callback promise, and a business with nobody on the rota has nobody to make
// that call either -- which surfaces as unowned-followup one operator later.
//
// This test is narrow on purpose. It does not try to police every finding's
// prose, which would be a check that fails on rewording rather than on being
// wrong. It pins the two claims that were measured, against the code that
// produces the behaviour they describe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const BOOKING_TOOL = read("packages", "agents", "src", "tools", "bookings.ts");

/** The bookingWithoutAnyone operator, from its declaration to the next one. */
function operatorSource() {
  const from = OPERATORS.indexOf("const bookingWithoutAnyone: Operator = {");
  const to = OPERATORS.indexOf("const wordingAwaitingReview", from);
  assert.ok(from > -1 && to > from, "could not find bookingWithoutAnyone");
  return OPERATORS.slice(from, to);
}

test("the empty-diary path offers a callback rather than refusing", () => {
  // This is the behaviour the finding describes, so it is the thing to check
  // the finding against. If this branch is ever changed to a flat refusal, the
  // finding's wording becomes right again and this test is what says so.
  const empty = BOOKING_TOOL.slice(BOOKING_TOOL.indexOf("if (offers.length === 0)"));
  const branch = empty.slice(0, empty.indexOf("return {", empty.indexOf("}") + 1));
  assert.match(branch, /Offer instead to have a colleague follow up/);
  assert.ok(
    !/nobody is available/i.test(branch),
    "the tool now refuses outright -- booking-without-anyone's wording needs revisiting"
  );
});

test("the finding does not claim customers are turned away", () => {
  const source = operatorSource();
  assert.ok(
    !/told nobody is available|answered with 'nobody is available'/i.test(source),
    "the finding asserts a customer experience the reply path does not produce"
  );
});

test("it names the consequence that does happen", () => {
  // A callback promise made by a business with nobody on the rota. That is the
  // real cost, and it is the one a reader can act on.
  const source = operatorSource();
  assert.match(source, /offered a call back instead/);
  assert.match(source, /nobody to make that call/);
});

test("both wordings agree with each other", () => {
  // The roster description and the finding detail are read in the same sitting,
  // one under "What is being watched" and one in the list above it. They drifted
  // once already, and a page that says two different things about one problem is
  // a page that gets believed about neither.
  const source = operatorSource();
  const description = OPERATORS.slice(
    OPERATORS.indexOf('slug: "booking-without-anyone"'),
    OPERATORS.indexOf("run:", OPERATORS.indexOf('slug: "booking-without-anyone"'))
  );
  assert.ok(
    !/nobody is available/i.test(description),
    "the roster description still carries the overstated wording"
  );
  assert.match(description, /promise to call back/);
  assert.ok(source.includes("call back"), "the detail and the description disagree");
});
