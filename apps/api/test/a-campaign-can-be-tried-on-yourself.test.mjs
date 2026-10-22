// A campaign can be tried on yourself first.
//
// A staff campaign always goes to the whole book — on 22 Oct 2026, 56 real
// Zipicka customers for the one person who could send. So nobody could find out
// whether a message actually arrives without sending it to everybody. A test
// goes through the SAME send the campaign uses, to one number the sender types.
//
// Not the profile number: connecting a WhatsApp Business number overwrites
// employees.whatsapp_number with that very number, and a number cannot message
// itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { internationalDigits, testSendRefusal } from "../src/routes/my-campaigns.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = readFileSync(join(here, "..", "src", "routes", "my-campaigns.ts"), "utf8");
const handler = ROUTE.slice(ROUTE.indexOf('myCampaignsRoute.post("/campaigns/test"'));
const body = handler.slice(0, handler.indexOf("\n});") + 4);

test("something that is not a phone number is refused", () => {
  assert.equal(testSendRefusal("abc", "+971 52 563 1476"), "That is not a phone number.");
  assert.equal(testSendRefusal("12345", "+971 52 563 1476"), "That is not a phone number.");
});

test("the number the campaign sends from is refused, whatever the spacing", () => {
  assert.equal(
    testSendRefusal("971525631476", "+971 52 563 1476"),
    "That is the number the campaign sends from — use your personal WhatsApp."
  );
});

test("an ordinary number is accepted", () => {
  assert.equal(testSendRefusal("+971 50 123 4567", "+971 52 563 1476"), null);
  assert.equal(testSendRefusal("+971 50 123 4567", null), null);
});

test("the test goes through the campaign's own send, with the campaign's own checks", () => {
  assert.ok(body.length > 50, "the route exists");
  assert.match(body, /sendWhatsAppTemplate\(/);
  assert.match(body, /staffTemplateParams\(template\.bodyParamCount, employee\.fullName\)/);
  assert.match(body, /explainSendError\(/);
  // One set of template checks for the test and the campaign, so a test that
  // passes is a campaign that would be accepted.
  assert.match(body, /templateRefusal\(/);
  const send = ROUTE.slice(ROUTE.indexOf('myCampaignsRoute.post("/campaigns", '));
  assert.match(send.slice(0, send.indexOf("\n});")), /templateRefusal\(/);
  const helper = ROUTE.slice(ROUTE.indexOf("function templateRefusal("));
  assert.match(helper.slice(0, 2500), /template\.whatsappBusinessAccountId !== sendingAccount/);
});

test("a test leaves no campaign behind and counts against nothing", () => {
  assert.doesNotMatch(body, /createStaffBroadcast|createBroadcastRecipients|getBroadcastSendQueue/);
});

test("REVIEW FINDING: a number without its country code is refused, not dialled abroad", () => {
  // "525631476" is a UAE mobile typed locally; dialled as-is it is +52 (Mexico).
  assert.equal(
    testSendRefusal("525631476", null),
    "Write the number with its country code, starting with + (for example +971 50 123 4567)."
  );
  assert.equal(testSendRefusal("0525631476", null), "Write the number with its country code, starting with + (for example +971 50 123 4567).");
  assert.equal(testSendRefusal("00971501234567", null), null);
  assert.equal(testSendRefusal("+971 50 123 4567", null), null);
});

test("REVIEW FINDING: a test cannot reach someone who opted out, nor run without limit", () => {
  assert.match(body, /isWaIdOptedOut\(/);
  assert.match(body, /takeTestSend\(desk\.employeeId\)/);
});

test("REVIEW FOLLOW-UP: 00 is an international prefix, not part of the number", () => {
  assert.equal(internationalDigits("00971 50 123 4567"), "971501234567");
  assert.equal(internationalDigits("+971 50 123 4567"), "971501234567");
  assert.match(body, /const toDigits = internationalDigits\(to\)/);
  assert.match(body, /isWaIdOptedOut\(toDigits\)/);
});
