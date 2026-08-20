// Four replies in nineteen seconds, and the last two did not know about each other.
//
// The inbound worker runs at concurrency 10 and nothing serialised work per
// conversation. People do not message in one tidy paragraph. Measured on
// production, 6 August, one contact:
//
//   13:25:50  in   "Hello dear"
//   13:25:56  out  "Hello! Welcome to Zipicka. How can I help you today?"
//   13:25:59  in   "How are u?"
//   13:26:03  out  "I'm doing great, thank you for asking! How can I help you today?"
//   13:26:03  in   [a property-data sales pitch]
//   13:26:05  in   "Do you want to purchase latest updates in very low price ?"
//   13:26:06  out  "Thank you for reaching out! I am the assistant for Zipicka..."
//   13:26:09  out  "Thank you for the offer, but we do not purchase external lead..."
//
// The last two are three seconds apart, answering two halves of one pitch,
// neither aware the other existed. Across the whole history five inbound pairs
// arrived under ten seconds apart out of thirty-nine messages — this is not an
// edge case here, it is how a meaningful share of people type.
//
// The lock does NOT merge the messages. That would be a debounce, which adds
// latency to every conversation to fix some of them. It makes the replies
// sequential, and sequential is what makes them coherent: the second job loads
// history after the first reply is written, so the agent can see it already
// said hello.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const LOCK = read("apps", "api", "src", "queue", "conversation-lock.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const WORKER = read("apps", "api", "src", "worker.ts");

test("the reply path takes the lock before it does anything", () => {
  // Before the tenant lookup, before recording the message — the whole decision
  // has to be inside it or two jobs still both decide.
  const fn = PROCESSOR.slice(
    PROCESSOR.indexOf("async function processSingleTextMessage"),
    PROCESSOR.indexOf("async function answerOneMessage")
  );
  assert.match(fn, /return withConversationLock\(phoneNumberId, message\.from, \(\) =>/);
  assert.match(fn, /answerOneMessage\(phoneNumberId, message, change, text\)/);
});

test("it is keyed on the sender, not the conversation", () => {
  // The conversation does not exist yet when the first message of one arrives,
  // and two simultaneous first messages are exactly the case that would race to
  // create it.
  assert.match(LOCK, /const scope = `\$\{phoneNumberId\}:\$\{contactWaId\}`/);
  assert.match(LOCK, /the conversation does not exist yet/);
});

test("contention waits instead of throwing", () => {
  // Throwing would spend one of the job's five attempts and push the reply
  // behind an exponential backoff, so a customer sending three quick messages
  // would wait LONGER for each. Contention is the normal case here.
  assert.match(LOCK, /const MAX_WAIT_MS = 20_000;/);
  assert.match(LOCK, /await new Promise\(\(resolve\) => setTimeout\(resolve, POLL_MS\)\)/);
  // And it does throw when the wait is exhausted, because twenty seconds in
  // flight is a stuck reply rather than a busy one.
  assert.match(LOCK, /throw new ConversationBusyError\(scope\)/);
});

test("the lock is released only by whoever holds it", () => {
  // A TTL expiry followed by somebody else acquiring must not let the first
  // job's release delete the second job's lock.
  assert.match(LOCK, /if redis\.call\("get", KEYS\[1\]\) == ARGV\[1\] then/);
  assert.match(LOCK, /redis\.eval\(RELEASE, 1, key, token\)/);
  assert.match(LOCK, /randomUUID\(\)/);
});

test("a failed release cannot cause a double reply", () => {
  // The release is in a finally, and its own failure is swallowed: turning a
  // delivered reply into a failed job would have BullMQ retry it and send the
  // same message twice, which is the defect this file exists to prevent.
  const release = LOCK.slice(LOCK.indexOf("} finally {"));
  assert.match(release, /catch \(err\)/);
  assert.match(release, /the TTL will/);
});

test("the TTL outlives a reply and a killed worker releases the customer", () => {
  assert.match(LOCK, /const LOCK_TTL_MS = 90_000;/);
  assert.match(LOCK, /a worker killed mid-reply releases the conversation/);
});

test("concurrency is still 10, because this serialises per customer not globally", () => {
  // Dropping the worker to concurrency 1 would also fix the double reply, by
  // making every business wait behind every other business.
  assert.match(WORKER, /INBOUND_WEBHOOK_QUEUE, processInboundWebhookJob, \{[\s\S]*?concurrency: 10/);
});
