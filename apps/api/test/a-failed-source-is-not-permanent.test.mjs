// A 429 removed eight pages from a law firm's knowledge base, permanently.
//
// On 2026-08-18 the knowledge re-index ran on schedule for the first time —
// the same day the tenant-context bug stopping it was fixed. It had a backlog of
// twenty stale sources to re-embed at once, exhausted the free tier's daily
// embedding quota, and Gemini returned 429 for the last eight.
//
// All eight were ABR's. All eight were marked `failed`. And `findStaleSources`
// excluded failed sources absolutely, so no later cycle ever retried them: the
// 00:00 and 06:00 runs both completed cleanly and skipped every one.
//
// `searchKnowledge` filters on `status = 'indexed'`, so 53 of ABR's 72 passages
// were invisible to its own agent for sixteen hours — a live law firm answering
// from a quarter of what it knows, while `broken-knowledge` reported it
// correctly to nobody.
//
// The transient error and the permanent one need different outcomes and the same
// mechanism. Retrying after a cooldown gives both WITHOUT classifying errors,
// which is the part that would rot: the taxonomy belongs to the provider.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const STALE = read("packages", "knowledge", "src", "stale.ts");

test("a failed source is retried, not written off", () => {
  assert.match(STALE, /const RETRY_FAILED_AFTER_HOURS = 24;/);
  assert.match(STALE, /or \(status = 'failed'/);

  // The absolute exclusion is gone. Asserted as a negative because that single
  // clause is the whole defect: everything else about the sweep was correct.
  assert.ok(
    !/and status <> 'failed'\s*\n\s*and \(last_checked_at/.test(STALE),
    "failed sources must no longer be excluded outright"
  );
});

test("the cooldown is longer than the ordinary staleness window", () => {
  // A page that fails every time should cost one attempt a day, not one every
  // cycle. The re-index runs every six hours.
  assert.match(STALE, /const RETRY_FAILED_AFTER_HOURS = 24;/);
  assert.match(STALE, /const olderThanHours = input\.olderThanHours \?\? 24;/);
  assert.match(STALE, /\$3 \|\| ' hours'/);
});

test("healthy sources are refreshed before failed ones are retried", () => {
  // Ordering by staleness alone puts failed sources at the front — they are by
  // definition the least recently successful — so a handful of permanently
  // broken pages would consume the whole per-run budget every cycle and starve
  // the refreshes that work.
  assert.match(STALE, /order by \(status = 'failed'\), last_checked_at asc nulls first/);
});

test("errors are not classified, and that is the point", () => {
  // Deciding "429 is transient, 404 is permanent" means owning a taxonomy that
  // belongs to the provider and changes without notice. The cooldown gives the
  // right outcome for both without anybody having to be right about which is
  // which.
  //
  // Asserted as the absence of a PREDICATE rather than the absence of a word.
  // The first version of this searched for "429" and failed on the SQL comment
  // that explains why the retry exists — a test that cannot tell a branch from
  // the sentence describing it.
  // Scoped to the SELECTOR. `markSourceFailed` lives in the same file and
  // writes `error = $2`, which a whole-file search reads as a predicate — the
  // second version of this test failed on an assignment in a different
  // function.
  const selector = STALE.slice(
    STALE.indexOf("export async function findStaleSources"),
    STALE.indexOf("export async function markSourceFailed")
  );
  assert.ok(
    !/error\s+(like|ilike|~|=)/i.test(selector),
    "the query must not branch on the content of an error"
  );
  assert.ok(!/case\s+when\s+error/i.test(selector), "no error taxonomy in the selector");
});
