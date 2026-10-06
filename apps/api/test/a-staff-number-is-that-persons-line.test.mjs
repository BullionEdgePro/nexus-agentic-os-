// On 6 Oct 2026 the shared company WhatsApp number was switched off at Meta and
// each staff member answers on their OWN WhatsApp Business number instead. These
// pin what that means: nothing reaches for the dead line, a person's number is
// their thread, their receipts land, and the owner can see who is connected.
// channelStatuses runs for real; the wiring is pinned as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { channelStatuses } from "../src/lib/channels.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("packages", "db", "migrations", "094-a-number-that-was-switched-off.sql");
const CONVERSATIONS = read("packages", "db", "src", "conversations.ts");
const DISPATCH = read("apps", "api", "src", "lib", "reply-dispatch.ts");
const MESSAGES = read("packages", "db", "src", "messages.ts");
const PROC = read("apps", "api", "src", "queue", "processor.ts");
const BROADCASTS = read("apps", "api", "src", "routes", "broadcasts.ts");
const CAMPAIGNS = read("apps", "api", "src", "routes", "my-campaigns.ts");
const EMPLOYEES = read("packages", "db", "src", "employees.ts");
const INBOX = read("packages", "db", "src", "inbox.ts");
const DESK = read("apps", "api", "src", "routes", "my-desk.ts");
const TEAM = read("apps", "web", "app", "deck", "team", "team-workspace.tsx");

const retired = { displayNumber: "+971 50 480 5436", retiredAt: "2026-10-06T00:00:00.000Z" };

test("WhatsApp is plainly live while the shared line answers", () => {
  const wa = channelStatuses().find((c) => c.channel === "whatsapp");
  assert.equal(wa.state, "live");
  assert.equal(wa.canSend, true);
});

test("once the line is switched off, WhatsApp counts the people answering on their own", () => {
  const none = channelStatuses({ retiredSharedNumber: retired, staffWithOwnNumber: 0, activeStaff: 6 })
    .find((c) => c.channel === "whatsapp");
  assert.equal(none.state, "awaiting-approval");
  assert.equal(none.canSend, false);
  assert.match(none.summary, /\+971 50 480 5436 was switched off/);
  assert.match(none.summary, /0 of 6 connected/);
  assert.ok(none.requirements.some((line) => /Meta/.test(line)), "the Meta blocker is named, not hidden");

  const some = channelStatuses({ retiredSharedNumber: retired, staffWithOwnNumber: 2, activeStaff: 6 })
    .find((c) => c.channel === "whatsapp");
  assert.equal(some.state, "live");
  assert.equal(some.canSend, true);

  const all = channelStatuses({ retiredSharedNumber: retired, staffWithOwnNumber: 6, activeStaff: 6 })
    .find((c) => c.channel === "whatsapp");
  assert.deepEqual(all.requirements, []);
});

test("the switch-off is a fact about a number, readable by the app", () => {
  assert.match(MIGRATION, /create table if not exists retired_whatsapp_numbers/);
  assert.match(MIGRATION, /phone_number_id text primary key/);
  assert.match(MIGRATION, /grant select, insert, delete on retired_whatsapp_numbers to nexus_app/);
});

test("a chat on a switched-off line has no number to reply from, and says so in words", () => {
  assert.match(CONVERSATIONS, /case when r\.phone_number_id is null\s+then coalesce\(c\.phone_number_id, o\.whatsapp_phone_number_id\) end/);
  assert.match(CONVERSATIONS, /left join retired_whatsapp_numbers r/);
  const wa = DISPATCH.slice(DISPATCH.indexOf('if (target.channel === "whatsapp")'));
  assert.ok(wa.indexOf("if (!target.phoneNumberId)") > -1);
  assert.ok(wa.indexOf("if (!target.phoneNumberId)") < wa.indexOf("sendWhatsAppText("), "refused before Meta is asked");
  assert.match(wa, /has been switched off, so Nexus cannot reply from it/);
});

test("no phone alert or campaign reaches for a dead line", () => {
  assert.match(INBOX, /case when r\.phone_number_id is null then own\.whatsapp_phone_number_id end as phone_number_id/);
  const send = BROADCASTS.slice(BROADCASTS.indexOf('broadcastsRoute.post("/:id/send"'));
  assert.ok(send.indexOf("isWhatsAppNumberRetired(organization.whatsappPhoneNumberId)") > -1);
  assert.ok(
    send.indexOf("isWhatsAppNumberRetired(organization.whatsappPhoneNumberId)") < send.indexOf("getBroadcastSendQueue()"),
    "refused before a single recipient is queued"
  );
  assert.match(CAMPAIGNS, /employee\.whatsappPhoneNumberId \?\? \(sharedRetired \? null : organization\.whatsappPhoneNumberId\)/);
  assert.match(CAMPAIGNS, /You have no WhatsApp number of your own yet/);
});

test("a customer writing to two colleagues has two threads, one per number", () => {
  const inbound = MESSAGES.slice(MESSAGES.indexOf("export async function recordInboundMessage("));
  assert.match(inbound, /and \(\$3::text is null or phone_number_id = \$3 or phone_number_id is null\)/);
  assert.match(inbound, /insert into conversations \(organization_id, contact_id, phone_number_id\) values \(\$1, \$2, \$3\)/);
  const echo = MESSAGES.slice(MESSAGES.indexOf("export async function recordOutboundEcho("));
  assert.match(echo, /and \(\$3::text is null or phone_number_id = \$3 or phone_number_id is null\)/);
  const staff = PROC.slice(PROC.indexOf("async function handleStaffNumberMessage("));
  assert.match(staff, /onNumber: employee\.whatsappPhoneNumberId,/);
});

test("a chat a staff member starts from their phone is theirs, unless it was handed on", () => {
  const echo = PROC.slice(PROC.indexOf("async function processMessageEcho("));
  assert.match(echo, /onNumber: employee\.whatsappPhoneNumberId,/);
  // claimForAutoAssign only writes where employee_id is null.
  assert.match(echo, /await claimForAutoAssign\(result\.conversationId, employee\.id, employee\.fullName\);/);
});

test("receipts for a staff member's own number land instead of being dropped", () => {
  const fn = PROC.slice(PROC.indexOf("async function processDeliveryStatuses("));
  assert.match(fn, /\(await findEmployeeByPhoneNumberId\(phoneNumberId\)\)\?\.organizationId/);
  assert.match(fn, /withTenant\(organizationId, \(\) =>/);
});

test("giving a line to someone brings it back from retirement", () => {
  const fn = EMPLOYEES.slice(EMPLOYEES.indexOf("export async function assignEmployeeWhatsAppNumber("));
  assert.ok(fn.indexOf("delete from retired_whatsapp_numbers where phone_number_id = $1") > -1);
  assert.ok(fn.indexOf("delete from retired_whatsapp_numbers") < fn.indexOf("with freed as"));
});

test("a number connected through Coexistence is the person's own, not 'missing'", () => {
  assert.match(DESK, /connection\.provider === "whatsapp" && connection\.externalId === own/);
  assert.match(DESK, /mine \|\| ownConnection\s+\? "own-number"/);
  assert.match(DESK, /sharedRetired\s+\? "no-number"/);
});

test("the owner sees who is connected and can send the instructions", () => {
  assert.match(TEAM, /<WhatsAppReadiness team=\{team\} \/>/);
});
