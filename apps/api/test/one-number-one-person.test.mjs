// Multiple WhatsApp, done the only way it can be: a DEDICATED number per staff,
// registered on the company account. NOT a personal WhatsApp — that has no API
// and faking it bans the account.
//
// This file guards the assignment layer: a number belongs to exactly one
// person, the shared company line can never be handed out, and only the owner
// assigns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const DB = read("packages", "db", "src", "employees.ts");
const ROUTE = read("apps", "api", "src", "routes", "employees.ts");
const PICKER = read("apps", "web", "app", "deck", "team", "whatsapp-number.tsx");

test("assigning a number first frees it from anyone else", () => {
  // Two staff can never share one inbound line, or the router could not say
  // whose a message is. The assign clears the number from any other holder in
  // the same statement.
  const fn = DB.slice(DB.indexOf("export async function assignEmployeeWhatsAppNumber"));
  assert.match(fn, /whatsapp_phone_number_id = \$2 and id <> \$1/);
  assert.match(fn, /set whatsapp_phone_number_id = \$2/);
});

test("there is a lookup from a number to its owning employee", () => {
  // The hinge of inbound routing: an unmapped-to-org number may be a staff
  // member's own. Unscoped, because it runs before any tenant is known.
  assert.match(DB, /export async function findEmployeeByPhoneNumberId/);
  const fn = DB.slice(DB.indexOf("export async function findEmployeeByPhoneNumberId"));
  assert.match(fn, /whatsapp_phone_number_id = \$1 and is_active = true/);
});

test("the shared company number can never be assigned to a person", () => {
  // Handing the shared line to one staff member would route the whole
  // business's inbox to them. Refused outright.
  const patch = ROUTE.slice(ROUTE.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/whatsapp-number"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /=== organization\.whatsappPhoneNumberId/);
  assert.match(body, /422/);
});

test("only a number Meta actually holds can be assigned", () => {
  // Checked against the live account list, not trusted from the request — a
  // typo'd id would otherwise store and route to a number that does not exist.
  const patch = ROUTE.slice(ROUTE.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/whatsapp-number"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /listWabaNumbers\(organization\.whatsappBusinessAccountId\)/);
  assert.match(body, /not on this WhatsApp account/);
});

test("assigning is operator-only", () => {
  const patch = ROUTE.slice(ROUTE.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/whatsapp-number"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /scope\?\.role !== "operator"/);
});

test("the picker states plainly this is not a personal WhatsApp", () => {
  // The single most important reliability message: nobody should think they can
  // connect the app on their phone.
  assert.match(PICKER, /[Nn]ot a personal WhatsApp|cannot be connected by any tool/);
});

// ============================================================
// Phase 2 — the routing (inbound to the owner, outbound from their number)
// ============================================================

const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const CONV = read("packages", "db", "src", "conversations.ts");

test("a message on a staff number falls through to its owner, and only then", () => {
  // The safety of the whole feature: the shared number ALWAYS resolves to an
  // organization first, so this branch runs only for a number a person was
  // given — dormant until one is assigned, and never able to touch the shared
  // pipeline.
  // Anchor on the inbound branch specifically (the delivery-status handler also
  // calls findOrganizationByPhoneNumberId), via the comment that marks it.
  const idx = PROCESSOR.indexOf("it may be a staff member's OWN");
  assert.ok(idx > -1, "the staff-number branch comment is missing");
  const block = PROCESSOR.slice(idx, idx + 500);
  assert.match(block, /findEmployeeByPhoneNumberId\(phoneNumberId\)/);
  assert.match(block, /handleStaffNumberMessage\(staffOwner/);
});

test("the staff-number path holds the twin out and hands the chat to the person", () => {
  const fn = PROCESSOR.slice(PROCESSOR.indexOf("async function handleStaffNumberMessage"));
  const body = fn.slice(0, fn.indexOf("\nasync function answerOneMessage"));
  assert.match(body, /assignConversationToEmployee\(result\.conversationId, employee\.id\)/);
  assert.match(body, /setConversationHandoff\(result\.conversationId, true, "taken_by_employee"/);
  // Pins the number so the reply leaves from it.
  assert.match(body, /setConversationPhoneNumber\(result\.conversationId, employee\.whatsappPhoneNumberId\)/);
  // Never runs the shared-number AI pipeline for this message.
  assert.ok(!/classifyBusiness|answerOneMessage\(/.test(body), "the staff path leaked into the AI pipeline");
});

test("a reply leaves from the number the conversation is on, not always the shared line", () => {
  // coalesce(conversation's own number, org shared) — a staff-number chat
  // replies from the staff number; everything else from the shared one, even
  // when handed to a staff member who happens to own a dedicated number.
  assert.match(CONV, /coalesce\(c\.phone_number_id, o\.whatsapp_phone_number_id\)/);
  assert.match(CONV, /export async function setConversationPhoneNumber/);
});
