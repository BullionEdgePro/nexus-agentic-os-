/**
 * The email channel reads a client's thread — and only a client's thread.
 *
 * The platform's whole email privacy design is one rule: never list the mailbox,
 * only ever query for addresses already in the client book. fetchClientMail (the
 * read-only view) obeys it; fetchClientMailFull, which the email CHANNEL uses to
 * pull BODIES into the inbox, must obey exactly the same rule. The only widening
 * is the format (full vs metadata) for those already-scoped messages.
 *
 * The one line that enforces it is the empty-list guard: a query built from no
 * addresses is an EMPTY query, and an empty query to Gmail returns EVERY message
 * — somebody's whole life instead of a client book. So the behavioural test here
 * is that no addresses returns nothing, before any network call is made.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchClientMailFull } from "../src/lib/gmail.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const GMAIL = read("apps", "api", "src", "lib", "gmail.ts");
// runEmailSync moved out of the route into the service, so the background sweep
// and the manual "sync now" share one definition — the privacy guard travelled
// with it, and this is where it now lives.
const EMAIL_SYNC_SERVICE = read("apps", "api", "src", "services", "email-sync.ts");
const EMAIL_SYNC = read("packages", "db", "src", "email-sync.ts");
const MIGRATION = read("packages", "db", "migrations", "086-email-in-the-inbox.sql");

test("no client addresses fetches nothing — never the whole mailbox", async () => {
  // Behavioural, and it makes no network call: the guard returns before fetch.
  // If this ever returns anything for an empty book, the query became an empty
  // query, which to Gmail means every message.
  const result = await fetchClientMailFull("unused-token", []);
  assert.deepEqual(result, [], "an empty address list must return no mail");
  const blanks = await fetchClientMailFull("unused-token", ["", "  ", null].filter(Boolean));
  assert.deepEqual(blanks, [], "addresses that are all blank must also return nothing");
});

test("the full fetch queries by client address, exactly like the metadata one", () => {
  // The OR-over-addresses query is the filter. If this construction ever drops,
  // the fetch would return unscoped mail.
  assert.match(
    GMAIL,
    /from:\$\{a\}\s*to:\$\{a\}|from:.*to:/,
    "fetchClientMailFull must still build the from:/to: address query"
  );
  const fn = GMAIL.slice(GMAIL.indexOf("export async function fetchClientMailFull"));
  assert.match(fn, /clean\.length === 0/, "it must guard the empty-address case");
});

// THE RULE CHANGED ON 2026-09-30, BY THE OWNER'S DECISION: a business mailbox
// now brings in every email a PERSON sends it, not only mail from customers
// already on file — that rule let nothing in, because no customer had an email
// saved. What still holds is that the read is BOUNDED: recent Primary-inbox
// mail only, capped per sweep, never the mailbox's history.
test("the sync reads recent Primary-inbox mail, bounded, never the whole mailbox", () => {
  const fn = EMAIL_SYNC_SERVICE.slice(EMAIL_SYNC_SERVICE.indexOf("async function runEmailSync"));
  assert.match(fn, /fetchRecentInboxMailFull\(accessToken, 40\)/);
  const fetch = GMAIL.slice(GMAIL.indexOf("export async function fetchRecentInboxMailFull"));
  assert.match(fetch, /"in:inbox category:primary newer_than:3d"/);
  assert.match(fetch, /maxResults=\$\{Math\.min\(limit, 50\)\}/);
});

test("a synced email cannot be stored twice", () => {
  // Dedup is what makes syncing on every inbox open safe. Both the write and the
  // index it relies on must be present.
  assert.match(
    EMAIL_SYNC,
    /on conflict \(email_message_id\)/,
    "insertSyncedEmailMessage must dedup on the Gmail message id"
  );
  assert.match(
    MIGRATION,
    /unique index[\s\S]*email_message_id/i,
    "migration 086 must add the unique index the dedup relies on"
  );
});
