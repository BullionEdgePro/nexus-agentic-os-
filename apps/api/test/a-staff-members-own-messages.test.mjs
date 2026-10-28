/**
 * Staff write their own campaign messages (28 Oct 2026), and each is theirs
 * alone. The template sync copies every template on a shared WhatsApp account
 * into every business, so ownership lives in the NAME — these pin that rule,
 * the wording Meta will accept, and the receipts a test send now waits for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  staffTemplateName,
  staffTemplatePrefix,
  staffMayUseTemplate,
  isStaffTemplate,
  staffTemplateLabel,
  staffTemplateBody,
} from "@nexus/shared";
import { testStateAdvances } from "../src/lib/campaign-test-status.ts";

const here = dirname(fileURLToPath(import.meta.url));
const source = (path) => readFileSync(join(here, "..", "src", path), "utf8");

const RALPH = "1a2b3c4d-0000-4000-8000-000000000001";
const KESHAV = "9f8e7d6c-0000-4000-8000-000000000002";

test("a staff message is named for its writer, in the characters Meta allows", () => {
  assert.equal(staffTemplatePrefix(RALPH), "staff_1a2b3c4d_");
  assert.equal(staffTemplateName(RALPH, "November Offer!"), "staff_1a2b3c4d_november_offer");
  assert.equal(staffTemplateName(RALPH, "عرض"), "staff_1a2b3c4d_message");
  assert.equal(staffTemplateLabel("staff_1a2b3c4d_november_offer"), "november offer");
});

test("a colleague's message is not yours; the business's are everyone's", () => {
  const ralphs = staffTemplateName(RALPH, "offer");
  assert.ok(isStaffTemplate(ralphs));
  assert.equal(staffMayUseTemplate(ralphs, RALPH), true);
  assert.equal(staffMayUseTemplate(ralphs, KESHAV), false);
  assert.equal(staffMayUseTemplate("sfs_property_update", KESHAV), true);
  assert.equal(isStaffTemplate("sfs_property_update"), false);
});

test("{name} becomes Meta's {{1}} with a sample, once, never at the start or end", () => {
  assert.deepEqual(staffTemplateBody("Hello {name}, new listings are in."), {
    body: "Hello {{1}}, new listings are in.",
    paramCount: 1,
    example: ["Sara"],
  });
  assert.deepEqual(staffTemplateBody("New listings are in."), { body: "New listings are in.", paramCount: 0, example: [] });
  assert.match(staffTemplateBody("{name}, hello there").error, /starts or ends/);
  assert.match(staffTemplateBody("Thanks for everything {name}!").error, /starts or ends/);
  assert.match(staffTemplateBody("Hi {name} and {name} again").error, /once/);
  assert.match(staffTemplateBody("Hi {{1}} there").error, /no other placeholders/);
  assert.match(staffTemplateBody("Hi {first} there").error, /no other placeholders/);
  assert.match(staffTemplateBody("   ").error, /Write the message/);
  assert.match(staffTemplateBody("x".repeat(1025)).error, /1024/);
});

test("the owner's picker and both business send routes refuse a staff member's message", () => {
  const broadcasts = source("routes/broadcasts.ts");
  assert.match(broadcasts, /filter\(\(template\) => !isStaffTemplate\(template\.metaTemplateName\)\)/);
  assert.equal(broadcasts.match(/if \(isStaffTemplate\(template\.metaTemplateName\)\)/g)?.length, 2);
});

test("a staff send checks the template is theirs, in the same refusal a test uses", () => {
  const route = source("routes/my-campaigns.ts");
  assert.match(route, /if \(!staffMayUseTemplate\(template\.metaTemplateName, employeeId\)\)/);
  assert.equal(route.match(/templateRefusal\(template, organization, sendingAccountOf\(employee, organization\), desk\.employeeId\)/g)?.length, 2);
});

test("a late receipt never undoes a later one, and a failure is final", () => {
  assert.equal(testStateAdvances("accepted", "sent"), true);
  assert.equal(testStateAdvances("delivered", "sent"), false);
  assert.equal(testStateAdvances("read", "delivered"), false);
  assert.equal(testStateAdvances("delivered", "failed"), true);
  assert.equal(testStateAdvances("failed", "read"), false);
});

test("a receipt that matched no row is offered to the test store before it is dropped", () => {
  const processor = source("queue/processor.ts");
  assert.match(processor, /if \(!moved && status\.status !== "queued"\) \{\s*const wasTest = await recordTestSendReceipt/);
  const route = source("routes/my-campaigns.ts");
  assert.match(route, /await noteTestSend\(messageId, desk\.employeeId\)/);
});
