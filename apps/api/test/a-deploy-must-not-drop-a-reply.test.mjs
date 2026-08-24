/**
 * A deploy must not kill a reply that is halfway out.
 *
 * ============================================================
 * WHY THIS EXISTS
 * ============================================================
 *
 * Two correct designs meeting badly.
 *
 * `worker.ts` closes every BullMQ worker on SIGTERM, and BullMQ's close() waits
 * for the job in flight to finish. That is right, and there is already a test
 * that every worker is in the list — one was missing once.
 *
 * `processor.ts` returns early when `recordInboundMessage` gives back a null id,
 * because that means `on conflict (wa_message_id) do nothing` matched: Meta has
 * redelivered a message already answered. That is right too, and the return
 * carries a SILENT-RETURN-OK marker so it cannot be mistaken for an omission.
 *
 * Together, on a container whose stop grace period is Docker's default ten
 * seconds, they lose customer messages. The inbound row is written first. If the
 * process is killed before the reply goes out, BullMQ retries the job, the
 * insert conflicts, the id comes back null, and the processor correctly
 * concludes it is a replay — of a reply that never happened. The customer gets
 * silence. The job completes green. Only `customer-waiting` notices, two hours
 * later.
 *
 * MEASURED, not guessed: across the replies in `conversation_metrics` on
 * 2026-08-24 the average first response took 10.2 seconds and the slowest took
 * 27.0. The average reply did not fit inside the window it was given.
 *
 * ============================================================
 * WHAT THIS PINS
 * ============================================================
 *
 * That the worker service declares a stop grace period, and that it is
 * comfortably longer than the slowest reply anybody has measured. A number
 * chosen once and then quietly lowered is the same defect returning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const COMPOSE = readFileSync(join(here, "..", "..", "..", "docker-compose.prod.yml"), "utf8");
const WORKER = readFileSync(join(here, "..", "src", "worker.ts"), "utf8");

/** The slowest first response ever measured here, in seconds. */
const SLOWEST_OBSERVED_REPLY_SECONDS = 27;

/** The block for one compose service, from its header to the next one. */
function service(name) {
  const at = COMPOSE.indexOf(`\n  ${name}:`);
  assert.notEqual(at, -1, `the ${name} service is not in docker-compose.prod.yml`);
  const rest = COMPOSE.slice(at + 1);
  const next = rest.search(/\n {2}[a-z][a-z0-9_-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next);
}

test("the worker is given longer to stop than a reply takes", () => {
  const block = service("worker");
  const match = /stop_grace_period:\s*(\d+)s/.exec(block);

  assert.ok(
    match,
    "the worker declares no stop_grace_period, so Docker allows it ten seconds — less than " +
      "the average reply measured on this platform, and a deploy will kill one mid-flight"
  );

  const seconds = Number(match[1]);
  assert.ok(
    seconds >= SLOWEST_OBSERVED_REPLY_SECONDS * 2,
    `stop_grace_period is ${seconds}s and the slowest measured reply took ` +
      `${SLOWEST_OBSERVED_REPLY_SECONDS}s. Leave real margin: the cost of being wrong is a ` +
      `customer who is never answered and a job that reports success.`
  );
});

test("the shutdown that the grace period is protecting still exists", () => {
  // A grace period is worth nothing if nothing waits during it. If SIGTERM
  // stopped closing the workers, the number above would be a comment.
  assert.match(WORKER, /process\.on\("SIGTERM", shutdown\)/);
  assert.match(WORKER, /inboundWorker\.close\(\)/);
});

test("the early return it interacts with is still the replay guard", () => {
  // If this stops being "a webhook replay" and becomes something else, the
  // reasoning above needs revisiting rather than inheriting.
  const PROCESSOR = readFileSync(join(here, "..", "src", "queue", "processor.ts"), "utf8");
  const at = PROCESSOR.indexOf("SILENT-RETURN-OK: a webhook retry is not a message");
  assert.notEqual(at, -1, "the replay guard is no longer recognisable — recheck the grace period");
});
