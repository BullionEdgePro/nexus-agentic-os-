// Round-robin auto-assign (migration 092; DoubleTick: auto-assign). Pinned as
// text, like the rest of the pipeline suite: the correctness is in who is
// eligible, which scope each read runs in, and that nothing is ever taken from
// someone who already has it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const AVAIL = read("apps", "api", "src", "services", "availability.ts");
const INBOX = read("packages", "db", "src", "inbox.ts");
const PROC = read("apps", "api", "src", "queue", "processor.ts").replace(/\r\n/g, "\n");
const MIGRATION = read("packages", "db", "migrations", "092-a-chat-finds-its-person.sql");
const ORG_ROUTE = read("apps", "api", "src", "routes", "organizations.ts");

const picker = AVAIL.slice(AVAIL.indexOf("export async function autoAssignIfEnabled"));

test("off for every business until its owner turns it on", () => {
  assert.match(MIGRATION, /auto_assign boolean not null default false/);
  assert.match(picker, /if \(!settings\.autoAssign\) return null;/);
  // Only the owner can switch it — the same operator gate as the other settings.
  const patch = ORG_ROUTE.slice(ORG_ROUTE.indexOf('organizationsRoute.patch("/:slug/inbox-settings"'));
  assert.match(patch.slice(0, 1200), /scope\?\.role !== "operator"/);
  assert.match(patch, /typeof body\.autoAssign !== "boolean"/);
});

test("only people on shift with their AI twin on are picked", () => {
  // Twin off + assigned = the pipeline goes quiet on that chat when they leave.
  assert.match(picker, /employee\.isActive && employee\.twinEnabled/);
  assert.match(picker, /resolvePresence\(employee, now, busy\.has\(employee\.id\)\)\.status === "online"/);
});

test("fewest open chats first, then whoever waited longest for one", () => {
  assert.match(picker, /if \(la\.open !== lb\.open\) return la\.open - lb\.open;/);
  assert.match(INBOX, /c\.employee_id = e\.id and c\.status in \('open', 'pending'\)/);
});

test("a chat that has someone is never taken from them", () => {
  const claim = INBOX.slice(INBOX.indexOf("export async function claimForAutoAssign"));
  assert.match(claim, /where id = \$1 and employee_id is null and not is_human_handoff/);
  assert.match(claim, /'assigned', 'auto-assign', 'Auto-assign'/);
  assert.match(INBOX, /\(employee_id is null and not is_human_handoff\) as needs/);
});

test("candidates are read as the serving business; the claim as the owner", () => {
  assert.match(picker, /withServingTenant\(servingOrganizationId, async \(\) => \{/);
  // claimForAutoAssign runs in the caller's (owner's) scope, outside that block.
  const inner = picker.slice(0, picker.indexOf("if (!pick) return null;"));
  assert.ok(!/claimForAutoAssign/.test(inner), "the claim must not run inside the serving scope");
});

test("it runs before the assignee is read, and cannot break a reply", () => {
  const at = PROC.indexOf("await autoAssignIfEnabled(serving.id, conversationId);");
  const read = PROC.indexOf("const employee = await resolveAssignedEmployee(conversationId, serving.id);");
  assert.ok(at > -1 && read > at, "auto-assign must happen before the assignee is resolved");
  assert.match(picker, /catch \(err\) \{[\s\S]*return null;/);
});

test("the assignee is looked up as the serving business", () => {
  // Before this, a routed business's assignee came back null and their twin
  // never answered — RLS showed the owner's scope none of their staff.
  const fn = PROC.slice(PROC.indexOf("async function resolveAssignedEmployee("));
  assert.match(fn.slice(0, 900), /withServingTenant\(servingOrganizationId, \(\) =>\s*findEmployeeForConversation\(conversationId\)/);
});
