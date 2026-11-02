/**
 * A quick send says who was messaged but not saved (3 Nov 2026).
 *
 * Each message is sent on WhatsApp first and recorded second. When the record
 * fails, the person still got it -- so they are neither "could not be sent" nor
 * "in that client's conversation", and the screen must not claim either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { describeQuickOutcome } from "../lib/quick-outcome.ts";

const NOT_SAVED = "Sent, but could not be saved to their conversation, so it will not show in the inbox.";

test("a person messaged but not saved is named, and the conversation promise is not made", () => {
  const shown = describeQuickOutcome({ sent: 2, failed: [], notRecorded: ["Sara"] });
  assert.equal(shown.ok, false);
  assert.doesNotMatch(shown.text, /Each one is in that client's conversation/);
  assert.match(shown.text, /^Sent to 2 people/);
  assert.deepEqual(shown.failed, [{ name: "Sara", reason: NOT_SAVED }]);
});

test("an answer from an API without notRecorded reads as before", () => {
  const shown = describeQuickOutcome({ sent: 2, failed: [] });
  assert.equal(shown.ok, true);
  assert.equal(shown.text, "Sent to 2 people. Each one is in that client's conversation.");
  assert.deepEqual(shown.failed, []);
});

test("a send that failed still says so", () => {
  const shown = describeQuickOutcome({ sent: 1, failed: [{ name: "Omar", reason: "Outside the 24-hour window" }], notRecorded: [] });
  assert.equal(shown.ok, false);
  assert.equal(shown.text, "Sent to 1 person; 1 could not be sent. Each one is in that client's conversation.");
});
