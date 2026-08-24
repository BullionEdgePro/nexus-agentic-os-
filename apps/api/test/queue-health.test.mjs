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
import { walk } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");

const HEALTH = read("apps", "api", "src", "queue", "queue-health.ts");
const INDEX = read("apps", "api", "src", "index.ts");
const strip = (t) => t.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, " ").replace(/^[ \t]*\/\/[^\n]*/gm, " ");

/**
 * Every queue constant this workspace declares, found rather than listed.
 *
 * Plain string scanning, no regex: "export const " followed by a token ending
 * in _QUEUE. Regexes written into this repository keep arriving with an
 * escaping level missing, and there is nothing here a regex would do better.
 */
function declaredQueues() {
  const names = new Set();
  const NEEDLE = "export const ";
  for (const dir of ["packages", "apps"]) {
    for (const file of walk(join(ROOT, dir), (name) => name.endsWith(".ts"))) {
      const src = readFileSync(file, "utf8");
      let at = src.indexOf(NEEDLE);
      while (at !== -1) {
        const from = at + NEEDLE.length;
        let to = from;
        while (to < src.length && /[A-Za-z0-9_]/.test(src[to])) to++;
        const token = src.slice(from, to);
        if (token.endsWith("_QUEUE")) names.add(token);
        at = src.indexOf(NEEDLE, at + 1);
      }
    }
  }
  return [...names].sort();
}

test("every queue this platform runs is watched", () => {
  // DERIVED, NOT LISTED. This iterated eight names typed into the test, under a
  // comment claiming "a new one is a visible omission" -- which it was not: a
  // ninth queue declared tomorrow would simply not appear here, and the health
  // endpoint would go on reporting eight green queues while the ninth failed
  // silently. The list happened to be complete on 2026-08-24; that is luck
  // holding a promise the test could not keep.
  const queues = declaredQueues();

  // Non-empty AND plausible: a derivation that silently finds nothing is the
  // same defect in better clothes, and this repository has shipped that too.
  assert.ok(
    queues.length >= 8,
    `only ${queues.length} queue constants found (${queues.join(", ")}) — the scan is probably broken`
  );

  for (const name of queues) {
    // includes, not a RegExp. The line this replaces built one from a template
    // literal, and inside a template literal a lone backslash-b is the BACKSPACE
    // ESCAPE -- so new RegExp received two control characters and matched
    // nothing. Every metacharacter class has this problem in a template
    // literal: backslash-d, -w and -s are unrecognised escapes and simply lose
    // their backslash. A constant named in SCREAMING_SNAKE needs no word
    // boundary anyway.
    assert.ok(
      HEALTH.includes(name),
      name + " is declared and not in the watched list"
    );
  }
});

test("a count alone cannot say whether something is wrong NOW", () => {
  // BullMQ keeps failed jobs until retention trims them, so `failed: 20`
  // describes both an outage happening this minute and one fixed hours ago. A
  // health field that stays red after the fix is one people learn to ignore.
  assert.match(HEALTH, /const FAILING_WINDOW_MS/);
  assert.match(HEALTH, /now - lastFailureAt < FAILING_WINDOW_MS/);

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
  // Collapsed, and checked as a PROPERTY rather than as a spelling. Both
  // assertions here pinned exact source text: `.catch(() => [])` on the
  // readQueueHealth call, and the ok expression on one line. Both went red
  // when that catch was replaced by a try that also reports the failure --
  // which is the very thing this test is named for. An assertion that breaks
  // when its subject improves is pinning an implementation.
  const flat = INDEX.replace(/\s+/g, " ");

  assert.ok(flat.includes("readQueueHealth("), "the endpoint no longer reads queue health");
  assert.ok(
    flat.includes("ok: stalled.length === 0 && failing.length === 0 && backedUp.length === 0"),
    "ok must still fall to false on a stalled job, a failing queue or a backed-up one"
  );

  // AND ON NOT BEING ABLE TO LOOK. `.catch(() => [])` used to make an
  // unreadable queue list indistinguishable from a healthy one -- empty
  // failing, empty backedUp, ok:true -- so a Redis outage, the single fault
  // that would stop every queue at once, reported a healthy schedule.
  assert.ok(
    flat.includes("!queuesUnreadable"),
    "a queue list that could not be read must make ok false, not empty"
  );

  // Named lists rather than a bare boolean: a monitor should be able to say
  // WHICH queue without a second request.
  assert.ok(flat.includes("failing, backedUp,"), "the endpoint must name the queues");
});

test("reading queue health cannot take the endpoint down", () => {
  // Redis being unreachable is itself worth reporting, and reporting it as a
  // 500 would read as "the API is down" when the API is the part still working.
  // The anchor is CHECKED, not trusted. The first version of this line looked
  // for a single quote where index.ts uses a double one, so indexOf returned
  // -1, slice(-1) handed back the last character of the file, and the
  // assertions below ran against one byte. That is the -1 class this suite has
  // a detector for -- which cannot see it here, because the argument is
  // computed rather than a literal on a whole-file binding.
  const at = INDEX.indexOf(String.fromCharCode(34) + "/health/jobs");
  assert.notEqual(at, -1, "the /health/jobs route is no longer recognisable in index.ts");
  const route = INDEX.slice(at);
  const flat = route.replace(/\s+/g, " ");
  assert.ok(flat.includes("try {") && flat.includes("readQueueHealth("),
    "the queue read must be guarded so an outage does not take the endpoint down");
  assert.ok(flat.includes("ok: false"), "the outer failure must still answer with ok:false");
});
