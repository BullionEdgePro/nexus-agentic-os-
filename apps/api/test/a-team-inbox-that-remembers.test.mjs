// The DoubleTick-style inbox, round 2 (migration 090): resolve, per-person
// unread, a timeline of what happened to a thread, notes as a timeline, and the
// per-business inbox settings — plus the three defects the audit found on the
// way (the oldest-50 message window, unattributed human replies, and a resolve
// that would have split a customer's history in two).
//
// The correctness lives in SQL and in which value flows where, so this pins
// those as text, the way the rest of the inbox suite does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const MIGRATION = read("packages", "db", "migrations", "090-a-team-inbox-that-remembers.sql");
const INBOX_DB = read("packages", "db", "src", "inbox.ts");
const MESSAGES_DB = read("packages", "db", "src", "messages.ts");
const CONVERSATIONS_DB = read("packages", "db", "src", "conversations.ts");
const SOCIAL_DB = read("packages", "db", "src", "social-identity.ts");
const ROUTE = read("apps", "api", "src", "routes", "conversations.ts");
const ORG_ROUTE = read("apps", "api", "src", "routes", "organizations.ts");
const ACTOR = read("apps", "api", "src", "lib", "actor.ts");
const CHANNELS = read("apps", "api", "src", "lib", "channels.ts");

test("every new table is tenant-isolated", () => {
  for (const table of ["conversation_events", "conversation_reads", "conversation_notes"]) {
    assert.match(
      MIGRATION,
      new RegExp(`alter table ${table} enable row level security`),
      `${table} must carry row-level security`
    );
    assert.match(MIGRATION, new RegExp(`create policy ${table}_tenant_isolation on ${table}`));
  }
});

test("a customer writing to a resolved conversation reopens it", () => {
  // The trigger — so no inbound writer has to remember it.
  assert.match(MIGRATION, /after insert on messages[\s\S]*when \(new\.direction = 'inbound'\)/);
  assert.match(MIGRATION, /set status = 'open', closed_at = null, closed_by = null[\s\S]*status = 'resolved'/);
  assert.match(MIGRATION, /'reopened', 'customer'/);
  // …and the lookups FIND a resolved conversation instead of opening a fresh,
  // history-less one beside it.
  assert.ok(!/status in \('open', 'pending'\)\s/.test(MESSAGES_DB), "WhatsApp lookup still skips resolved threads");
  assert.match(MESSAGES_DB, /status in \('open', 'pending', 'resolved'\)/);
  assert.match(SOCIAL_DB, /status in \('open', 'pending', 'resolved'\)/);
});

test("resolving is recorded once, from the update's own output", () => {
  assert.match(INBOX_DB, /status is distinct from \$2/);
  assert.match(INBOX_DB, /insert into conversation_events[\s\S]*select organization_id, id, \$4, \$3, \$5 from changed/);
  // A hard 'closed' is not reopened by the button.
  assert.match(INBOX_DB, /status in \('open', 'pending', 'resolved'\)/);
});

test("a thread shows its LATEST messages, oldest-first", () => {
  // It used to be `order by created_at asc limit N` — the OLDEST N — so a long
  // thread stopped showing anything new and Suggest-reply read the wrong end.
  assert.match(MESSAGES_DB, /order by m\.created_at desc\s*\n[^\n]*\n\s*limit \$2\s*\n\s*\) latest\s*\n\s*order by created_at asc/);
});

test("a reply sharing its question's timestamp counts as the later message", () => {
  // Inbound and the reply to it are written in one transaction, so created_at
  // ties. The list, the thread and My Day must all read outbound as last —
  // production showed answered threads as "SLA breached" until they did.
  assert.match(CONVERSATIONS_DB, /order by created_at desc,\s*case when direction = 'outbound' then 0 else 1 end/);
  assert.match(MESSAGES_DB, /order by m\.created_at desc\s*,\s*case when m\.direction = 'outbound' then 0 else 1 end/);
  assert.match(MESSAGES_DB, /order by created_at asc\s*,\s*case when direction = 'inbound' then 0 else 1 end/);
  assert.match(
    read("apps", "api", "src", "routes", "my-day.ts"),
    /order by created_at desc,\s*case when direction = 'outbound' then 0 else 1 end/
  );
});

test("a human reply is attributed from the session, never the request body", () => {
  assert.ok(!/body\.senderId/.test(ROUTE), "the route still reads a senderId the client never sends");
  assert.match(ROUTE, /senderId: actor\.id \?\? undefined/);
  assert.match(ROUTE, /setConversationHandoff\(conversationId, true, "human_replied", actor\.id\)/);
  assert.match(ACTOR, /c\.get\("scope"\)/);
});

test("unread is per person and counts from their last look", () => {
  assert.match(CONVERSATIONS_DB, /left join conversation_reads rd on rd\.conversation_id = c\.id and rd\.reader = \$3/);
  assert.match(CONVERSATIONS_DB, /mu\.direction = 'inbound'[\s\S]*mu\.created_at > coalesce\(\s*rd\.last_read_at/);
  // Filed under the SERVING business so the list query (run under that scope) sees it.
  assert.match(INBOX_DB, /coalesce\(routed_organization_id, organization_id\), now\(\)/);
  assert.match(ORG_ROUTE, /getConversationsForOrganization\(organization\.id, 200, reader\)/);
});

test("only the owner changes the inbox settings, within bounds", () => {
  const at = ORG_ROUTE.indexOf('organizationsRoute.patch("/:slug/inbox-settings"');
  assert.ok(at > -1, "the settings route is gone");
  const handler = ORG_ROUTE.slice(at, at + 2600);
  assert.match(handler, /scope\?\.role !== "operator"/);
  assert.match(handler, /n < 5 \|\| n > 10080/);
  assert.match(MIGRATION, /sla_minutes between 5 and 10080/);
});

test("a note can only be deleted by the colleague who wrote it", () => {
  assert.match(INBOX_DB, /author is not distinct from \$3/);
});

test("the channel page never claims a channel that cannot send", () => {
  // SMS and phone have no adapter; an env var must not flip them to live.
  const sms = CHANNELS.slice(CHANNELS.indexOf('channel: "sms"'), CHANNELS.indexOf('channel: "phone"'));
  assert.match(sms, /state: "needs-setup"/);
  assert.match(sms, /canSend: false/);
  // Email is two-way and has been since the email channel shipped.
  const email = CHANNELS.slice(CHANNELS.indexOf('channel: "email"'), CHANNELS.indexOf('channel: "sms"'));
  assert.match(email, /state: "live"/);
});
