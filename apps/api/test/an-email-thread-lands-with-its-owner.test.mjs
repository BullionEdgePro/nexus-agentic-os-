// A client's email lands in the "My chats" of the staff member whose mailbox it
// came from — not in Unassigned, where staff (who open the inbox on "My chats")
// never saw it.
//
// Pinned as text, like the rest of the inbox suite: the correctness is in which
// id flows into the insert, and in the rule that a sync never re-assigns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const DB = read("packages", "db", "src", "email-sync.ts");
const SERVICE = read("apps", "api", "src", "services", "email-sync.ts");
const MIGRATION = read("packages", "db", "migrations", "091-an-email-thread-belongs-to-its-mailbox.sql");

const finder = DB.slice(
  DB.indexOf("export async function findOrCreateEmailConversation"),
  DB.indexOf("export interface SyncedEmail")
);

test("the sync hands the mailbox's owner to the conversation it creates", () => {
  assert.match(
    SERVICE,
    /findOrCreateEmailConversation\(\s*owner\.organizationId,\s*contactId,\s*owner\.employeeId\s*\)/
  );
  assert.match(finder, /insert into conversations \(organization_id, contact_id, channel, status, employee_id\)/);
});

test("an existing thread's assignee is never touched by a sync", () => {
  // The early return comes before any write: a thread somebody was handed, or
  // handed back, stays exactly as it is however often the sync runs.
  const early = finder.indexOf("if (existing.rows[0]) return existing.rows[0].id;");
  assert.ok(early > -1, "the existing-thread early return is gone");
  assert.ok(early < finder.indexOf("insert into conversations"));
  assert.ok(!/update conversations/.test(finder), "the finder must never re-assign");
});

test("the automatic assignment is written on the thread's timeline", () => {
  assert.match(finder, /insert into conversation_events[\s\S]*'assigned', 'email-sync', 'Email sync'/);
  assert.match(MIGRATION, /insert into conversation_events[\s\S]*'assigned', 'email-sync', 'Email sync'/);
});

test("the catch-up only takes unassigned threads, for active owners in the serving business", () => {
  assert.match(MIGRATION, /c\.employee_id is null/);
  assert.match(MIGRATION, /e\.is_active/);
  assert.match(MIGRATION, /e\.organization_id = coalesce\(c\.routed_organization_id, c\.organization_id\)/);
});
