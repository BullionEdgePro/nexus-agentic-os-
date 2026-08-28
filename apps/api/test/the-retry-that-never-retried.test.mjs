/**
 * Four faults in a send path nothing has ever run.
 *
 * ============================================================
 * WHY NONE OF THESE COULD HAVE BEEN NOTICED
 * ============================================================
 *
 * `broadcast_recipients` has zero rows. No campaign has been sent, so every
 * line of the delivery path is code that has never executed against Meta, and
 * all four of these would have surfaced for the first time in front of real
 * customers.
 *
 *   1. THE RETRY WAS DEAD. The queue is configured `attempts: 3` with
 *      exponential backoff, and the processor caught every error and returned
 *      normally — so BullMQ saw a job that succeeded and never retried
 *      anything. Configuration that reads as resilience and does nothing.
 *
 *      This lands hardest on a bulk send. WhatsApp rate-limits throughput, so a
 *      campaign of any size meets 429s partway through, and each one would have
 *      permanently marked a person failed on the first try.
 *
 *   2. THE REASON WAS THROWN AWAY. `delivery_error` has existed since migration
 *      051 and nothing had ever written to it. A wrong number, a rate limit and
 *      a template Meta had withdrawn all rendered identically as "failed" —
 *      three different problems with three different answers, shown as one.
 *
 *   3. EVERY OUTCOME WAS "COMPLETED". The status was written on "nothing is
 *      pending", so a campaign in which every message failed finished in
 *      exactly the state of one where every message arrived. `failed` has been
 *      an allowed status since the table was created and nothing ever set it.
 *
 *   4. AND A RECIPIENT COULD HAVE STUCK AT PENDING for ever, holding the whole
 *      broadcast open, if a retry path left it unsettled on the final attempt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isUpstreamUnavailable } from "../src/queue/../scripts/upstream.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const PROCESSOR = read("apps", "api", "src", "queue", "broadcast-processor.ts");
const QUEUE = read("apps", "api", "src", "queue", "broadcast-queue.ts");
const DB = read("packages", "db", "src", "broadcasts.ts");

// ============================================================
// 1. The retry
// ============================================================

test("a transient failure is rethrown, so the configured retry actually happens", () => {
  // The queue asks for three attempts. Swallowing the error meant it got one.
  assert.match(QUEUE, /attempts:\s*3/, "the retry policy is gone");
  assert.match(PROCESSOR, /throw err;/, "a transient failure is swallowed again, and never retried");
  assert.match(
    PROCESSOR,
    /isUpstreamUnavailable\(err\)/,
    "the processor no longer distinguishes a vendor outage from a bad request"
  );
});

test("a permanent failure is not retried three times to reach the same answer", () => {
  // A malformed number does not become valid on the second attempt. Backing off
  // and asking again only delays the row settling, and on a large campaign it
  // delays every row behind it.
  assert.match(PROCESSOR, /canRetry/);
  assert.match(
    PROCESSOR,
    /job\.attemptsMade \+ 1 < attemptsAllowed/,
    "there is no last-attempt check, so a row can stay pending after the final try"
  );
});

test("the vendor distinction is the narrow one, not a shrug", () => {
  // Real behaviour, not a source grep: this is the same function the two
  // model-calling gates use, and every widening of it turns a real error into
  // "somebody else's problem".
  assert.equal(isUpstreamUnavailable({ status: 429 }), true, "a rate limit is worth retrying");
  assert.equal(isUpstreamUnavailable({ status: 503 }), true);
  assert.equal(isUpstreamUnavailable({ status: 400 }), false, "a malformed request is ours");
  assert.equal(isUpstreamUnavailable({ status: 401 }), false, "an expired token is ours");
  assert.equal(
    isUpstreamUnavailable(new Error("Recipient phone number not in allowed list")),
    false,
    "a refusal about the recipient must not be retried as an outage"
  );
});

// ============================================================
// 2. The reason
// ============================================================

test("a failed recipient records why", () => {
  assert.match(DB, /delivery_error = case when \$2 = 'sent' then null else \$4 end/);
  assert.match(
    PROCESSOR,
    /updateBroadcastRecipientStatus\(recipientId, "failed", null, reason\)/,
    "the reason is discarded again"
  );
});

test("a reason is cleared when a later attempt succeeds", () => {
  // Otherwise a recipient who failed once and then succeeded keeps an
  // explanation for something that no longer happened — which is exactly the
  // sort of stale fact this deck exists to avoid showing.
  assert.match(DB, /then null else \$4 end/);
});

test("a hostile error message cannot write a novel into the row", () => {
  // The message comes from a vendor response body.
  assert.match(DB, /\?\.slice\(0, 500\)/);
});

// ============================================================
// 3. The outcome
// ============================================================

test("a campaign where everything failed does not report as completed", () => {
  assert.match(DB, /export async function broadcastOutcome/);
  assert.ok(
    !/isBroadcastFullyProcessed/.test(PROCESSOR),
    "the boolean is back, and a boolean cannot tell all-sent from all-failed"
  );
  assert.match(
    PROCESSOR,
    /outcome\.sent === 0 && outcome\.failed > 0 \? "failed" : "completed"/,
    "every outcome is still written as completed"
  );
});

test("the outcome counts delivered as sent", () => {
  // Receipts move a row from 'sent' to 'delivered'. Counting only 'sent' would
  // mark a fully delivered campaign as failed the moment the receipts landed —
  // a status that gets WORSE as the news gets better.
  const fn = DB.slice(DB.indexOf("export async function broadcastOutcome"));
  assert.match(fn, /status in \('sent', 'delivered'\)/, "a delivered message must count as sent");
});
