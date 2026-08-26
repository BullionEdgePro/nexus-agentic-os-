/**
 * When a failed knowledge source is tried again.
 *
 * ============================================================
 * THE DISTINCTION, AND THE REFUSAL IT DOES NOT OVERTURN
 * ============================================================
 *
 * `findStaleSources` retried every failed source after a flat 24 hours, and the
 * comment above that constant explains why it will not classify provider
 * errors: the taxonomy belongs to somebody else and it rots. That reasoning is
 * right and stands.
 *
 * What it did not separate is the one case where the other end TOLD US to come
 * back. A 429 and a 404 waited the same day.
 *
 * Measured on 2026-08-26: the embedding provider's free tier hit its quota and
 * returned 429 for five of ABR's pages — litigation, maritime law, property
 * law, our expertise, overview, which is most of what a law firm does. The
 * quota cleared within the hour and those pages were still going to serve stale
 * content for another twenty-three, on a key that will reach the same limit
 * again tomorrow.
 *
 * ============================================================
 * WHY THIS IS ALLOWED TO EXIST AT ALL
 * ============================================================
 *
 * It fails safe. If the wording stops matching, the delay falls back to the
 * flat cooldown — today's behaviour. The narrowing can stop working; it cannot
 * make anything worse. That is the property these tests care about most.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { looksRateLimited, retryAfterFor } from "@nexus/knowledge";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const STALE = read("packages", "knowledge", "src", "stale.ts");
const MIGRATION = read(
  "packages",
  "db",
  "migrations",
  "069-a-rate-limit-is-not-a-broken-page.sql"
);

/** Verbatim from ABR's knowledge_sources.error on 2026-08-26. */
const PRODUCTION_429 =
  '{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details."}}';

const hoursFrom = (error) =>
  Math.round(retryAfterFor(error, new Date(0)).getTime() / 3_600_000);

// ============================================================
// The one bit it recognises
// ============================================================

test("the error that actually happened is recognised", () => {
  // Not a synthetic string. This is the text that was sitting in five rows.
  assert.equal(looksRateLimited(PRODUCTION_429), true);
  assert.equal(hoursFrom(PRODUCTION_429), 1);
});

test("the shapes other providers use for the same thing", () => {
  // 429 and 503 are HTTP, not a vendor's vocabulary, which is the whole reason
  // this narrowing is allowed where a general taxonomy is not.
  for (const wording of [
    "HTTP 429 Too Many Requests",
    "503 Service Unavailable",
    "Rate limit exceeded, retry after 30s",
    "RESOURCE_EXHAUSTED: quota exceeded for embeddings",
  ]) {
    assert.equal(looksRateLimited(wording), true, `not recognised: ${wording}`);
  }
});

// ============================================================
// Everything else is untouched
// ============================================================

test("a genuinely broken page still waits a full day", () => {
  // A page that fails every time should cost one attempt a day, not one every
  // cycle — which is what the flat cooldown was for and still is.
  for (const wording of [
    "HTTP 404 Not Found",
    "HTTP 500 Internal Server Error",
    "Unparseable URI: not-a-url",
    "Refusing to fetch private address",
    "Unsupported content-type application/pdf",
  ]) {
    assert.equal(looksRateLimited(wording), false, `wrongly treated as transient: ${wording}`);
    assert.equal(hoursFrom(wording), 24);
  }
});

test("an unrecognised error falls back to the old behaviour, not to nothing", () => {
  // THE PROPERTY THAT MAKES THIS SAFE. If a provider rewords its errors past
  // recognition, every source waits the flat cooldown — exactly as it did
  // before this distinction existed.
  assert.equal(looksRateLimited("something nobody has seen before"), false);
  assert.equal(hoursFrom("something nobody has seen before"), 24);
  assert.equal(hoursFrom(null), 24);
  assert.equal(hoursFrom(undefined), 24);
  assert.equal(hoursFrom(""), 24);
});

test("a transient delay is shorter than the ordinary one, and neither is zero", () => {
  // Zero would hammer a provider that has just asked for a pause, which is the
  // failure the flat cooldown was protecting against in the first place.
  assert.ok(hoursFrom(PRODUCTION_429) >= 1);
  assert.ok(hoursFrom(PRODUCTION_429) < hoursFrom("HTTP 404 Not Found"));
});

// ============================================================
// Decided once, at the moment it is known
// ============================================================

test("the delay is written when the failure happens, not re-derived later", () => {
  // The error string is the provider's and may be reworded between the failure
  // and the read. The moment it arrived is when its meaning was known.
  assert.ok(
    STALE.includes("retry_after = $3"),
    "the failure writer does not record when to try again"
  );
  assert.ok(STALE.includes("retryAfterFor(error)"), "the delay is not computed at failure time");
  assert.match(MIGRATION, /add column if not exists retry_after timestamptz/);
});

test("a row that failed before the column existed keeps the old rule", () => {
  // Null must not read as "due now" — that would retry every legacy failure on
  // the next cycle, which is the stampede the cooldown exists to prevent.
  assert.ok(
    STALE.includes("retry_after is null"),
    "rows predating the column are not handled"
  );
  assert.ok(
    STALE.includes("(retry_after is not null and retry_after <= now())"),
    "a due source is not selected by its recorded time"
  );
});

test("healthy sources are still refreshed before failed ones", () => {
  // Unchanged, and load-bearing: a handful of permanently broken pages would
  // otherwise consume the whole per-run budget every cycle and starve the
  // refreshes that work. Shortening the retry on rate limits makes that
  // pressure HIGHER, not lower, so this ordering matters more than it did.
  assert.ok(
    STALE.includes("order by (status = 'failed'), last_checked_at asc nulls first"),
    "failed sources can now crowd out healthy ones"
  );
});

test("the SQL comment carries no backtick", () => {
  // It lives inside a template literal, and one would end the string. Asserted
  // because it was written with one on the first attempt — despite the same
  // warning already standing in operators.ts, which is how a lesson recorded in
  // one file fails to reach the next.
  // INSIDE the string, not from the call. The first version of this sliced
  // from `getPool().query(` and found the template literal's own opening
  // delimiter — a test that fails on the thing it is checking for being
  // present at all, which is no test.
  const BACKTICK = String.fromCharCode(96);
  const call = STALE.indexOf("const { rows } = await getPool().query");
  assert.ok(call > -1, "the stale-source query is gone");
  const opens = STALE.indexOf(BACKTICK, call);
  const to = STALE.indexOf("limit $2", opens);
  assert.ok(opens > -1 && to > opens);
  assert.ok(
    !STALE.slice(opens + 1, to).includes(BACKTICK),
    "a backtick inside the query would end the template literal"
  );
});
