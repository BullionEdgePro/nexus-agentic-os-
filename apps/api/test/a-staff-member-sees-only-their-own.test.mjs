// A staff member sees only their own conversations.
//
// FOUND 22 OCT 2026 (the owner: "staff can see other staff's conversations —
// make it private for each staff; only the admin sees all"). Every check on a
// conversation compared the BUSINESS and never the person:
//
//   - GET /:slug/conversations returned the whole business (200 rows) to any
//     staff member; the inbox's "My chats" was a client-side filter only.
//   - requireConversationScope let a staff member open any colleague's chat by
//     id — its messages, notes, details, tasks, bookings and AI summary — and
//     write to it, including re-assigning it to themselves.
//   - the live inbox socket trusted a client-chosen ?org and, with none, sent
//     EVERY business's messages to whoever was signed in.
//
// The rule (owner's decision): a conversation is visible to the staff member
// it belongs to (conversations.employee_id) and to any colleague the admin
// added as a collaborator. A conversation that belongs to nobody — a business
// mailbox email, a page message, an old shared-number chat — is the admin's
// until they assign it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { conversationVisibleTo } from "@nexus/db";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const GUARD = read("apps", "api", "src", "middleware", "require-tenant-scope.ts");
const ORGS = read("apps", "api", "src", "routes", "organizations.ts");
const CONVERSATIONS = read("packages", "db", "src", "conversations.ts");
const HUB = read("apps", "api", "src", "ws", "inbox-hub.ts");

const me = "11111111-1111-1111-1111-111111111111";
const colleague = "22222222-2222-2222-2222-222222222222";

test("my own conversation is visible to me", () => {
  assert.equal(conversationVisibleTo({ employeeId: me, collaboratorIds: [] }, me), true);
});

test("a colleague's conversation is not", () => {
  assert.equal(conversationVisibleTo({ employeeId: colleague, collaboratorIds: [] }, me), false);
});

test("a conversation that belongs to nobody is the admin's, not mine", () => {
  assert.equal(conversationVisibleTo({ employeeId: null, collaboratorIds: [] }, me), false);
});

test("a colleague's conversation the admin added me to is visible", () => {
  assert.equal(conversationVisibleTo({ employeeId: colleague, collaboratorIds: [me] }, me), true);
});

test("the conversation guard checks the person, not only the business", () => {
  const guard = GUARD.slice(GUARD.indexOf("export const requireConversationScope"));
  const body = guard.slice(0, guard.indexOf("\n};"));
  assert.match(body, /conversationVisibleTo\(/);
  // Same answer as "no such conversation": a refusal that differs would tell a
  // staff member which ids are their colleagues' chats.
  assert.ok(body.indexOf("conversationVisibleTo(") < body.lastIndexOf("return next()"));
  assert.match(body, /\{ error: "Conversation not found" \}, 404/);
});

test("the business inbox list is filtered to the staff member on the server", () => {
  const handler = ORGS.slice(ORGS.indexOf('organizationsRoute.get("/:slug/conversations"'));
  const body = handler.slice(0, handler.indexOf("\n});"));
  assert.match(body, /role === "employee"/);
  assert.match(body, /getConversationsForOrganization\(organization\.id, 200, reader, viewer\)/);
  const fn = CONVERSATIONS.slice(CONVERSATIONS.indexOf("export async function getConversationsForOrganization("));
  assert.match(fn.slice(0, 6000), /c\.employee_id = \$\d+[\s\S]{0,80}collaborator_ids/);
});

test("the live socket is pinned to the session's business and the person's own chats", () => {
  // Never the client's ?org for a staff member, and no "receive everything".
  assert.match(HUB, /session\.role === "operator"/);
  assert.match(HUB, /session\.organizationSlug/);
  assert.match(HUB, /conversationVisibleTo\(/);
  assert.doesNotMatch(HUB, /organizationSlug: string \| null; \/\/ null = no filter, receive every event/);
});
