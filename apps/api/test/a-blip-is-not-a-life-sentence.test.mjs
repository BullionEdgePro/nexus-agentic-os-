// A network blip is not a life sentence for a knowledge page.
//
// FOUND 21 OCT 2026 by retrieval-check: "can you attest a power of attorney?"
// and "who can witness my signature?" came back with the wrong Juris Prime
// pages. Both right pages were in the database — status 'failed', error
// "fetch failed" / "This operation was aborted", some since August. Each
// six-hourly sweep fetched them cleanly, found the content unchanged, and took
// the hash shortcut, which touched last_checked_at and nothing else. Nine of
// seventeen Juris Prime pages were out of search that way, while the website
// answered 200 in a third of a second.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { clearsFailureOnUnchangedContent, shouldRetrySoon } from "@nexus/knowledge";

const here = dirname(fileURLToPath(import.meta.url));
const INGEST = readFileSync(join(here, "..", "..", "..", "packages", "knowledge", "src", "ingest.ts"), "utf8");

test("a reset connection is cleared by a clean, unchanged fetch", () => {
  // Verbatim from knowledge_sources.error on 2026-10-21 (six Juris Prime pages).
  assert.equal(clearsFailureOnUnchangedContent("failed", "fetch failed"), true);
});

test("a timed-out fetch counts as the server never answering", () => {
  // fetchDocument gives up on a slow page by aborting its own controller, and
  // Node words that "This operation was aborted" — no "timeout" in it, so it
  // waited the full cooldown and was never cleared. Three pages carried it.
  assert.equal(shouldRetrySoon("This operation was aborted"), true);
  assert.equal(clearsFailureOnUnchangedContent("failed", "This operation was aborted"), true);
});

test("a definitive failure stays failed, however often the content matches", () => {
  assert.equal(clearsFailureOnUnchangedContent("failed", "HTTP 404 fetching truecopyattestions.com"), false);
  assert.equal(
    clearsFailureOnUnchangedContent(
      "failed",
      "Every passage on this page is placeholder text (Lorem ipsum), so nothing was indexed. The page most likely still carries its website theme's sample content."
    ),
    false
  );
});

test("a healthy source is not touched", () => {
  assert.equal(clearsFailureOnUnchangedContent("indexed", null), false);
  assert.equal(clearsFailureOnUnchangedContent("pending", null), false);
});

test("the shortcut actually uses it, and a failed embed cannot be vouched for later", () => {
  assert.match(INGEST, /clearsFailureOnUnchangedContent\(existing\[0\]\.status, existing\[0\]\.error\)/);
  assert.match(INGEST, /set last_checked_at = now\(\), status = 'indexed', error = null, retry_after = null/);
  // The catch path clears the hash, so passages never embedded from this
  // content cannot be waved through by the shortcut on the next sweep.
  assert.match(INGEST, /set status = 'failed', error = \$2, last_checked_at = now\(\), content_hash = null/);
});
