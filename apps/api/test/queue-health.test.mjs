// Twenty failed jobs sat in Redis and nothing had ever looked.
//
// `bull:knowledge-reindex:failed` held twenty of them on 2026-08-18. BullMQ had
// been recording every throw for as long as the re-index had been broken, and
// the heartbeat table — six hours old — found the same outage that morning. The
// evidence was already there; the difference was only that one of them is
// somewhere a person reads.
//
// migration 050 answers "did the scheduled work run?" by having each job write
// down that it did. That is a record of jobs which STARTED. It says nothing
// about work sitting unprocessed, and nothing about work that failed every retry
// and was set aside.
//
// THE INBOUND QUEUE IS WHY THIS MATTERS. `customer-waiting` catches a customer
// who got no reply — but it sweeps CONVERSATIONS, and `recordInboundMessage` is
// the first thing the job does. A job that fails before that leaves no
// conversation, no contact and no message: somebody messaged this business and
// there is nothing anywhere to sweep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const HEALTH = read("apps", "api", "src", "queue", "queue-health.ts");
const INDEX = read("apps", "api", "src", "index.ts");
const strip = (t) => t.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, " ").replace(/^[ \t]*\/\/[^\n]*/gm, " ");

test("every queue this platform runs is watched", () => {
  // Listed from the exported constants rather than as strings, so a renamed
  // queue is a compile error and a new one is a visible omission.
  for (const name of [
    "INBOUND_WEBHOOK_QUEUE",
    "BROADCAST_SEND_QUEUE",
    "OPERATORS_QUEUE",
    "QUALITY_ROLLUP_QUEUE",
    "TEMPLATE_SYNC_QUEUE",
    "KNOWLEDGE_REINDEX_QUEUE",
    "PROCEDURE_INFERENCE_QUEUE",
    "FORECAST_QUEUE",
  ]) {
    assert.match(HEALTH, new RegExp(`\\b${name}\\b`), `${name} is not in the watched list`);
  }
});

test("a count alone cannot say whether something is wrong NOW", () => {
  // BullMQ keeps failed jobs until retention trims them, so `failed: 20`
  // describes both an outage happening this minute and one fixed hours ago. A
  // health field that stays red after the fix is one people learn to ignore.
  assert.match(HEALTH, /const FAILING_WINDOW_MS/);
  assert.match(HEALTH, /failing: lastFailureAt !== null && now - lastFailureAt < FAILING_WINDOW_MS/);

  // Read from the sorted set's score rather than by fetching the job, because
  // the inbound queue's payload is a customer's message.
  assert.match(HEALTH, /zrange\(`bull:\$\{name\}:failed`, -1, -1, "WITHSCORES"\)/);
  assert.ok(
    !/getFailed\(/.test(HEALTH),
    "must not fetch failed job payloads — the inbound queue's payload is a customer's message"
  );
});

test("a later success clears the flag, or every fixed outage stays red", () => {
  // This one bit immediately: the re-index failed at 12:07, was fixed, succeeded
  // at 12:09, and the endpoint went on reporting ok:false for a job that was
  // demonstrably working. A red light that survives the fix is the same failure
  // the window was added to prevent, one step further on.
  assert.match(HEALTH, /!succeededSince\(lastFinishedByJob\[name\], lastFailureAt\)/);
  assert.match(HEALTH, /function succeededSince/);

  // The six scheduled queues share their names with their heartbeat jobs, so
  // there is no mapping table to drift. The two that are not scheduled have no
  // heartbeat, and for those a recent failure stands on its own — there is no
  // later success to weigh it against.
  assert.match(INDEX, /Object\.fromEntries\(beats\.map\(\(beat\) => \[beat\.job, beat\.lastFinishedAt\]\)\)/);
});

test("backed up means depth AND no worker, not depth alone", () => {
  // Waiting is normal for a moment. A deep queue with workers on it is a busy
  // platform; a deep queue with none is a stopped one, and only the second is
  // worth waking somebody for.
  assert.match(strip(HEALTH), /backedUp: waiting >= BACKLOG_THRESHOLD && active === 0/);
});

test("the shared Redis connection is not closed underneath the process", () => {
  // The handles are short-lived because the API process does not own most of
  // these queues and must not start workers by touching their singletons. The
  // CONNECTION is the process's own — closing it would take the API's other
  // queues down with it.
  assert.match(HEALTH, /await queue\.close\(\)/);
  assert.ok(!/connection\.quit\(|connection\.disconnect\(/.test(HEALTH));
});

test("the endpoint reports it, and a queue problem makes ok false", () => {
  assert.match(INDEX, /readQueueHealth\(\)\.catch\(\(\) => \[\]\)/);
  assert.match(INDEX, /ok: stalled\.length === 0 && failing\.length === 0 && backedUp\.length === 0/);

  // Named lists rather than a bare boolean: a monitor should be able to say
  // WHICH queue without a second request.
  assert.match(INDEX, /failing,\s*\n\s*backedUp,/);
});

test("reading queue health cannot take the endpoint down", () => {
  // Redis being unreachable is itself worth reporting, and reporting it as a
  // 500 would read as "the API is down" when the API is the part still working.
  const route = INDEX.slice(INDEX.indexOf('app.get("/health/jobs"'));
  assert.match(route, /readQueueHealth\(\)\.catch/);
  assert.match(route, /catch \(err\) \{[\s\S]*?ok: false/);
});
