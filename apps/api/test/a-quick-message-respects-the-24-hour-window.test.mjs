/**
 * Staff asked to send their own words, now, without waiting for Meta to
 * approve a template (29 Oct 2026). WhatsApp allows that only inside the 24
 * hours after the customer last wrote to the number, so a quick message goes
 * to exactly those people and nobody else. Alongside it, every approved
 * message's wording can be read before it is chosen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { personalise } from "../src/routes/my-campaigns.ts";
import { textFromComponents } from "../src/lib/template-text.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const ROUTE = read("apps", "api", "src", "routes", "my-campaigns.ts");
const DB = read("packages", "db", "src", "messages.ts");

const quick = ROUTE.slice(ROUTE.indexOf('myCampaignsRoute.post("/quick-message"'), ROUTE.indexOf('myCampaignsRoute.get("/templates/:id/text"'));

test("the window is the customer's last message to THIS number, inside 24 hours", () => {
  const fn = DB.slice(DB.indexOf("export async function openWindowConversations"), DB.indexOf("export async function nameContactIfUnnamed"));
  assert.match(fn, /c\.phone_number_id = \$2/);
  assert.match(fn, /m\.direction = 'inbound'/);
  assert.match(fn, /interval '23 hours 50 minutes'/);
});

test("a quick message re-reads the window at send time and goes from the person's own number", () => {
  assert.match(quick, /const from = employee\.whatsappPhoneNumberId;\s*if \(!from\)/);
  assert.match(quick, /quickMessageAudience\(desk\.organizationId, from, book\)/);
  assert.match(quick, /if \(!employee\.canBroadcast\)/);
});

test("it is sent and recorded as an ordinary reply, never a template campaign", () => {
  assert.match(quick, /sendReplyOnChannel\(/);
  assert.match(quick, /insertOutboundMessage\(/);
  assert.doesNotMatch(quick, /createStaffBroadcast|sendWhatsAppTemplate|getBroadcastSendQueue/);
});

test("{name} becomes the first name, or 'there'", () => {
  assert.equal(personalise("Hi {name}, offers today", "Sara Khan"), "Hi Sara, offers today");
  assert.equal(personalise("Hi {NAME}!", null), "Hi there!");
});

test("a template's wording is read as the customer sees it", () => {
  assert.deepEqual(
    textFromComponents([
      { type: "HEADER", format: "TEXT", text: "November offers" },
      { type: "BODY", text: "Hello {{1}}, new listings are in." },
      { type: "FOOTER", text: "Reply STOP to opt out" },
      { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }] },
    ]),
    { header: "November offers", body: "Hello {{1}}, new listings are in.", footer: "Reply STOP to opt out", buttons: ["Stop"] }
  );
  assert.equal(textFromComponents([{ type: "HEADER", format: "IMAGE" }]), null);
  assert.equal(textFromComponents([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "x" }]).header, "[image]");
});

test("a staff member reads only a message they may send, on the account they send from", () => {
  const preview = ROUTE.slice(ROUTE.indexOf('myCampaignsRoute.get("/templates/:id/text"'));
  assert.match(preview, /staffMayUseTemplate\(template\.metaTemplateName, desk\.employeeId\)/);
  assert.match(preview, /template\.whatsappBusinessAccountId !== account\.wabaId/);
});
