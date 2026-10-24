// Staff talk to their own team — and only their own (24 Oct 2026).
//
// The owner asked for "a chat box for each of the business staff ... can talk
// to their colleague for the designated business. only." Decided with them:
// one team room per business, private 1-to-1 chats between colleagues of the
// same business, and the admin reads all of it and may post in the rooms.
// Spec: docs/superpowers/specs/2026-10-24-team-chat-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { teamAccess, directPair } from "../../../packages/db/src/team-chat.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const ZIP = "11111111-1111-1111-1111-111111111111";
const SFS = "22222222-2222-2222-2222-222222222222";
const RALPH = "aaaaaaaa-0000-0000-0000-000000000001";
const SHAH = "aaaaaaaa-0000-0000-0000-000000000002";
const AZIZ = "aaaaaaaa-0000-0000-0000-000000000003";
const KESHAV = "bbbbbbbb-0000-0000-0000-000000000001";

const room = { id: "r", organizationId: ZIP, kind: "room", memberA: null, memberB: null };
const ralphShah = { id: "d", organizationId: ZIP, kind: "direct", memberA: RALPH, memberB: SHAH };
const staff = (employeeId, organizationId) => ({ kind: "staff", employeeId, organizationId });
const admin = { kind: "admin", adminId: "admin-1", name: "Admin" };

// ---- Task 1: who may do what -------------------------------------------------

test("a staff member reads and writes in their own business's room", () => {
  assert.deepEqual(teamAccess(room, staff(RALPH, ZIP)), { read: true, post: true });
});

test("a staff member reads and writes in a direct chat they are in", () => {
  assert.deepEqual(teamAccess(ralphShah, staff(SHAH, ZIP)), { read: true, post: true });
});

test("a colleague cannot read two other people's direct chat", () => {
  assert.deepEqual(teamAccess(ralphShah, staff(AZIZ, ZIP)), { read: false, post: false });
});

test("another business's staff see nothing, room or direct", () => {
  assert.deepEqual(teamAccess(room, staff(KESHAV, SFS)), { read: false, post: false });
  assert.deepEqual(teamAccess(ralphShah, staff(KESHAV, SFS)), { read: false, post: false });
});

test("the admin reads and posts in a room, and only reads a direct chat", () => {
  assert.deepEqual(teamAccess(room, admin), { read: true, post: true });
  assert.deepEqual(teamAccess(ralphShah, admin), { read: true, post: false });
});

test("a direct pair is stored in one order, whoever starts it", () => {
  assert.deepEqual(directPair(SHAH, RALPH), directPair(RALPH, SHAH));
  assert.ok(directPair(SHAH, RALPH)[0] < directPair(SHAH, RALPH)[1]);
});

test("the tables keep one room per business, one thread per pair, one message per send", () => {
  const sql = read("packages", "db", "migrations", "101-team-chat.sql");
  for (const table of ["team_threads", "team_messages", "team_reads"]) {
    assert.match(sql, new RegExp(`create table if not exists ${table}`));
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`));
    assert.match(sql, new RegExp(`grant select, insert, update, delete on ${table} to nexus_app`));
  }
  assert.match(sql, /where kind = 'room'/);
  assert.match(sql, /where kind = 'direct'/);
  assert.match(sql, /unique \(thread_id, client_id\)/);
  assert.match(sql, /member_a < member_b/);
  assert.match(sql, /char_length\(body\) between 1 and 4000/);
});

test("a retried send lands once", () => {
  const DB = read("packages", "db", "src", "team-chat.ts");
  assert.match(DB, /on conflict \(thread_id, client_id\) do nothing/);
});

// ---- Task 2: the route -------------------------------------------------------

const ROUTE = () => read("apps", "api", "src", "routes", "team-chat.ts");
const handler = (src, signature) => {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `missing ${signature}`);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf("\n});") + 4);
};

test("a staff member removed from the team is refused on the next request", () => {
  const src = ROUTE();
  const viewer = src.slice(src.indexOf("async function viewerOf"));
  assert.match(viewer.slice(0, viewer.indexOf("\n}\n")), /!employee\.isActive/);
});

test("a direct chat opens only with an active colleague of the same business, never yourself", () => {
  const body = handler(ROUTE(), 'teamChatRoute.post("/direct"');
  assert.match(body, /colleague\.organizationId !== /);
  assert.match(body, /!colleague\.isActive/);
  assert.match(body, /=== who\.viewer\.employeeId/);
});

test("a retried send answers with the first message, 200 not 201", () => {
  const body = handler(ROUTE(), 'teamChatRoute.post("/threads/:id/messages"');
  assert.match(body, /created \? 201 : 200/);
  assert.match(body, /clientId/);
});

test("mentions are kept only for people of the thread's business", () => {
  const src = ROUTE();
  const fn = src.slice(src.indexOf("function validMentions"));
  assert.match(fn.slice(0, fn.indexOf("\n}\n")), /isActive/);
});

test("a customer chat is handed over only in a direct chat, by someone who can see it", () => {
  const body = handler(ROUTE(), 'teamChatRoute.post("/threads/:id/messages"');
  assert.match(body, /thread\.kind !== "direct"/);
  assert.match(body, /conversationVisibleTo\(viewers, who\.viewer\.employeeId\)/);
  assert.match(body, /setConversationCollaborators/);
});

test("the admin cannot post into a direct chat", () => {
  const body = handler(ROUTE(), 'teamChatRoute.post("/threads/:id/messages"');
  assert.match(body, /!access\.post/);
});

test("the event goes out after the message is saved", () => {
  const body = handler(ROUTE(), 'teamChatRoute.post("/threads/:id/messages"');
  const published = body.indexOf('publish(await eventFor(thread, "team_message"');
  assert.ok(published > 0, "the message is published");
  assert.ok(body.indexOf("postTeamMessage(") < published);
});

test("database work runs inside the business's tenant scope, and the route is mounted", () => {
  assert.ok((ROUTE().match(/withTenant\(/g) ?? []).length >= 5);
  assert.match(read("apps", "api", "src", "index.ts"), /app\.route\("\/api\/team-chat", teamChatRoute\)/);
});

// ---- Task 3: live delivery ---------------------------------------------------

test("the live connection carries team chat on its own path, by the same rule", () => {
  const HUB = read("apps", "api", "src", "ws", "inbox-hub.ts");
  assert.match(HUB, /TEAM_PATH = "\/ws\/team"/);
  assert.match(HUB, /subscribeToTeamEvents/);
  // A staff socket hears its own business's room and its own direct chats only.
  assert.match(HUB, /event\.kind === "room" \|\| event\.members\.includes\(client\.employeeId\)/);
  assert.match(HUB, /client\.organizationSlug === event\.organizationSlug/);
  // The inbox stream never carries team chat, nor team the inbox.
  assert.match(HUB, /client\.stream !== "team"/);
  assert.match(HUB, /client\.stream !== "inbox"/);
});

// ---- Task 4: the screen ------------------------------------------------------

const PAGE = () => read("apps", "web", "app", "deck", "team-chat", "page.tsx");

test("staff are told, on the screen, that the admin can read team chats", () => {
  assert.match(PAGE(), /Your admin can read team chats\./);
});

test("a message that fails says so and resends with the same id", () => {
  // Since 24 Oct (Focus workspace) these rules live in one hook and one list,
  // shared by the Team chat page and the dock beside the inbox.
  const HOOK = read("apps", "web", "lib", "use-team-thread.ts");
  assert.match(HOOK, /crypto\.randomUUID\(\)/);
  assert.match(HOOK, /function retry\(pending: PendingMessage\)[\s\S]{0,300}pending\.clientId/);
  assert.match(read("apps", "web", "app", "team-chat-thread.tsx"), /Not sent · Retry/);
  assert.match(PAGE(), /useTeamThread\(/);
});

test("nothing missed while offline is lost: re-read on reconnect, and every 15 seconds without a socket", () => {
  const src = PAGE();
  assert.match(src, /onReconnect/);
  assert.match(src, /15_000/);
  assert.match(read("apps", "web", "lib", "use-team-socket.ts"), /\/ws\/team/);
});

test("the admin reads a direct chat without a composer", () => {
  assert.match(PAGE(), /Read only — between/);
});

test("Team chat is in the sidebar, and the inbox can hand a customer to a colleague", () => {
  const NAV = read("apps", "web", "lib", "nav.tsx");
  assert.match(NAV, /href: "\/deck\/team-chat",\s*label: "Team chat"/);
  const INBOX = read("apps", "web", "app", "inbox", "page.tsx");
  assert.match(INBOX, /<AskColleague/);
  assert.match(read("apps", "web", "app", "inbox", "ask-colleague.tsx"), /Gives \{/);
});

test("the customer exports are offered to the admin only", () => {
  const CU = read("apps", "web", "app", "deck", "customers", "page.tsx");
  assert.match(CU, /isOperator \? \(\s*<div className="cu-export">/);
});
