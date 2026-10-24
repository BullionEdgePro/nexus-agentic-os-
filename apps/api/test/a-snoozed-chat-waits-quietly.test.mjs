// A snoozed chat waits quietly — until its time comes or the customer writes
// (24 Oct 2026, Focus workspace). Spec:
// docs/superpowers/specs/2026-10-24-focus-workspace-design.md §2
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { snoozeWindowError } from "../../../packages/db/src/conversations.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("a conversation remembers until when, since when and by whom it is snoozed", () => {
  const sql = read("packages", "db", "migrations", "102-snooze.sql");
  assert.match(sql, /snoozed_until timestamptz/);
  assert.match(sql, /snoozed_at timestamptz/);
  assert.match(sql, /snoozed_by text/);
});

test("the rule: snoozed while the time is ahead AND the customer has not written since", () => {
  const DB = read("packages", "db", "src", "conversations.ts");
  assert.match(DB, /export const NOT_SNOOZED_SQL/);
  const rule = DB.slice(DB.indexOf("export const NOT_SNOOZED_SQL"));
  assert.match(rule.slice(0, 600), /snoozed_until > now\(\)/);
  assert.match(rule.slice(0, 600), /ms\.created_at > c\.snoozed_at/);
});

test("a snooze must be 5 minutes to 30 days ahead", () => {
  const now = Date.parse("2026-10-24T12:00:00Z");
  assert.equal(snoozeWindowError("2026-10-24T11:00:00Z", now) !== null, true, "in the past");
  assert.equal(snoozeWindowError("2026-10-24T12:02:00Z", now) !== null, true, "under 5 minutes");
  assert.equal(snoozeWindowError("2026-12-01T12:00:00Z", now) !== null, true, "over 30 days");
  assert.equal(snoozeWindowError("not a date", now) !== null, true, "nonsense");
  assert.equal(snoozeWindowError("2026-10-24T15:00:00Z", now), null, "three hours is fine");
});

test("every waiting count leaves a snoozed chat out", () => {
  assert.match(read("apps", "api", "src", "services", "operators.ts"), /NOT_SNOOZED_SQL/);
  assert.match(read("packages", "db", "src", "staff-work.ts"), /NOT_SNOOZED_SQL/);
  assert.match(read("apps", "api", "src", "routes", "my-day.ts"), /NOT_SNOOZED_SQL/);
  const INBOX = read("apps", "web", "app", "inbox", "page.tsx");
  assert.match(INBOX, /isSnoozed\(c, now\)/);
});

test("snooze and wake are routes behind the conversation guard", () => {
  const ROUTE = read("apps", "api", "src", "routes", "conversations.ts");
  assert.match(ROUTE, /conversationsRoute\.post\("\/:id\/snooze"/);
  assert.match(ROUTE, /conversationsRoute\.delete\("\/:id\/snooze"/);
  assert.match(read("apps", "api", "src", "index.ts"), /app\.use\("\/api\/conversations\/:id\/\*", requireConversationScope\)/);
});

test("the list carries the reason for each chat", () => {
  const DB = read("packages", "db", "src", "conversations.ts");
  assert.match(DB, /as lead_category/);
  assert.match(read("packages", "shared", "src", "types.ts"), /leadCategory\?: string \| null/);
});
