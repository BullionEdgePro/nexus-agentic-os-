/**
 * A vendor being down is not this platform being broken.
 *
 * ============================================================
 * WHAT HAPPENED
 * ============================================================
 *
 * On 2026-08-27, twice inside twenty minutes, verify-all.sh printed:
 *
 *   self-check        FAIL
 *   retrieval-check   FAIL
 *
 * Google's generative API was returning 503 UNAVAILABLE. Nothing was wrong with
 * the platform, and the only way to establish that was to open the output file
 * and read a stack trace. On the summary line those two were indistinguishable
 * from the reply path being broken.
 *
 * A gate that goes red for a reason the reader cannot act on teaches them to
 * re-run rather than to read, and a suite people re-run until it is green is
 * not a suite.
 *
 * ============================================================
 * AND IT IS NOT A PASS
 * ============================================================
 *
 * The tempting fix is to swallow the outage and stay green. That is worse:
 * retrieval quality genuinely WAS NOT CHECKED on those runs. The rule is the
 * one /health/jobs already applies to `queuesUnreadable` -- "I could not check"
 * is not "nothing is wrong", and the two must not answer a monitor alike.
 *
 * So: three outcomes, and the third suppresses the "All gates pass" line that a
 * deploy is signed off on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  isUpstreamUnavailable,
  upstreamNotice,
  EXIT_UPSTREAM_UNAVAILABLE,
} from "../src/scripts/upstream.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const VERIFY = read("scripts", "verify-all.sh");
const RETRIEVAL = read("apps", "api", "src", "scripts", "retrieval-check.ts");
const SELF = read("apps", "api", "src", "scripts", "self-check.ts");

// ============================================================
// What counts as somebody else's problem
// ============================================================

test("the actual error from the outage is recognised", () => {
  // THE REAL SHAPE, copied from what the gate printed that morning. The Google
  // SDK throws an ApiError whose message is a JSON blob and whose status is on
  // the object -- recognising it in the abstract is not the same as recognising
  // it, so this is the string that actually appeared.
  const real = Object.assign(
    new Error('{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}'),
    { status: 503 }
  );
  assert.equal(isUpstreamUnavailable(real), true);

  // And with the status stripped, so it rests on the message alone -- which is
  // how it arrives when the SDK wraps it one layer further out.
  const messageOnly = new Error(
    '{"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}'
  );
  assert.equal(isUpstreamUnavailable(messageOnly), true);
});

test("rate limiting and gateway errors count", () => {
  assert.equal(isUpstreamUnavailable({ status: 429 }), true);
  assert.equal(isUpstreamUnavailable({ status: 502 }), true);
  assert.equal(isUpstreamUnavailable({ status: 504 }), true);
});

test("a request that never landed counts", () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]) {
    assert.equal(isUpstreamUnavailable({ code }), true, `${code} should count`);
  }
});

test("our own mistakes stay red", () => {
  // THE DIRECTION THAT MATTERS. Every widening here converts a real defect into
  // a shrug: a malformed request, an expired key or a revoked permission are
  // this platform's problems, and a gate that stood down on them would report a
  // broken reply path as somebody else's outage.
  assert.equal(isUpstreamUnavailable({ status: 400 }), false, "a bad request is ours");
  assert.equal(isUpstreamUnavailable({ status: 401 }), false, "an expired key is ours");
  assert.equal(isUpstreamUnavailable({ status: 403 }), false, "a revoked permission is ours");
  assert.equal(isUpstreamUnavailable({ status: 404 }), false);
  assert.equal(isUpstreamUnavailable({ status: 500 }), false, "a 500 from them may be our payload");
});

test("an ordinary failure is not mistaken for an outage", () => {
  assert.equal(isUpstreamUnavailable(new Error("expected 3 slots, got 0")), false);
  assert.equal(isUpstreamUnavailable(new TypeError("x is not a function")), false);
  assert.equal(isUpstreamUnavailable(null), false);
  assert.equal(isUpstreamUnavailable(undefined), false);
});

test("the word 'unavailable' alone is not enough", () => {
  // A finding titled "Agent has almost nothing to answer from" could easily
  // carry the word. The match is anchored on the vendor's own status field.
  assert.equal(isUpstreamUnavailable(new Error("the knowledge source is unavailable")), false);
  assert.equal(isUpstreamUnavailable(new Error("retrieval-unavailable fired")), false);
});

// ============================================================
// What it says
// ============================================================

test("the notice says what was NOT checked", () => {
  // The part a person reading a green-looking run needs, and the part an
  // outage message would otherwise omit entirely.
  const notice = upstreamNotice("retrieval-check", "Retrieval quality", new Error("503 UNAVAILABLE"));
  assert.match(notice, /UNVERIFIED/);
  assert.match(notice, /Retrieval quality is UNCHECKED by this run/);
  assert.match(notice, /Nothing here says it is working/);
  assert.match(notice, /nothing here says it is broken/);
});

// ============================================================
// Where it is wired
// ============================================================

test("both model-calling gates stand down rather than fail", () => {
  assert.match(RETRIEVAL, /isUpstreamUnavailable\(err\)/);
  assert.match(RETRIEVAL, /EXIT_UPSTREAM_UNAVAILABLE/);
  assert.match(SELF, /isUpstreamUnavailable\(err\)/);
  assert.match(SELF, /EXIT_UPSTREAM_UNAVAILABLE/);
});

test("a real failure still exits 1 in both", () => {
  // The branch below the outage check. If this were removed, every failure of
  // these two gates would read as somebody else's outage.
  assert.match(RETRIEVAL, /process\.exitCode = 1/);
  assert.match(SELF, /process\.exit\(1\)/);
});

test("the runner renders the third outcome as its own state", () => {
  assert.match(VERIFY, new RegExp(`code" -eq ${EXIT_UPSTREAM_UNAVAILABLE}`));
  assert.match(VERIFY, /CODES\+=\("UNVERIFIED"\)/);
  assert.ok(
    !/unverified.*failed=\$\(\(failed \+ 1\)\)/s.test(VERIFY.slice(VERIFY.indexOf("-eq 75"), VERIFY.indexOf("else"))),
    "an unverified gate must not be counted as a failure"
  );
});

test("a run that checked less than it looks like refuses to say otherwise", () => {
  // THE WHOLE POINT. "All gates pass" is the sentence this file is read for,
  // and printing it after a gate stood down would make it mean less every time
  // it appeared.
  assert.match(VERIFY, /PASS, WITH \$\{unverified\} UNVERIFIED/);
  const summary = VERIFY.slice(VERIFY.indexOf('if [ "$unverified" -gt 0 ]'));
  assert.match(summary, /neither confirmed nor denied/);
  // Exits 0, because nothing is known to be broken and blocking a deploy on
  // somebody else's outage helps nobody.
  assert.match(summary, /exit 0/);
});
