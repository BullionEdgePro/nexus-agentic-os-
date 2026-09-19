// A reply must leave by the door the conversation came in on.
//
// Every human and scheduled reply went straight to WhatsApp, which was right
// while every conversation was WhatsApp. Now a conversation has a `channel`, and
// slice 4 routes the send accordingly — a WhatsApp number, a Messenger PSID, an
// Instagram IGSID — through one dispatcher so the inbox send and the scheduled
// sweep cannot each get it subtly wrong. The decisions are in the branch and the
// SQL, so this pins them as text, the way the rest of the channel suite does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const DISPATCH = read("apps", "api", "src", "lib", "reply-dispatch.ts");
const ROUTE = read("apps", "api", "src", "routes", "conversations.ts");
const SCHEDULED = read("apps", "api", "src", "queue", "scheduled-messages-processor.ts");
const CONNECTIONS = read("packages", "db", "src", "social-connections.ts");
const MESSAGES = read("packages", "db", "src", "messages.ts");
const CONVERSATIONS = read("packages", "db", "src", "conversations.ts");

test("Facebook and Instagram replies go out via the Page send, not WhatsApp", () => {
  assert.match(DISPATCH, /target\.channel === "facebook" \|\| target\.channel === "instagram"/);
  assert.match(DISPATCH, /sendPageMessage\(/);
  assert.match(DISPATCH, /recipientId: target\.contactExternalId/, "a social reply addresses the PSID/IGSID, not a phone");
});

test("a WhatsApp reply still goes out via WhatsApp", () => {
  assert.match(DISPATCH, /target\.channel === "whatsapp"/);
  assert.match(DISPATCH, /sendWhatsAppText\(target\.phoneNumberId, target\.contactWaId/);
});

test("an unsupported channel is refused, never silently sent on WhatsApp", () => {
  // email/sms/phone have no send path; the dispatcher must throw rather than fall
  // through to the WhatsApp branch.
  assert.match(DISPATCH, /is not available yet/);
  // The WhatsApp send is guarded by an explicit channel check, so it cannot be
  // the default arm of the function.
  const waAt = DISPATCH.indexOf('target.channel === "whatsapp"');
  const throwAt = DISPATCH.indexOf("is not available yet");
  assert.ok(waAt !== -1 && throwAt > waAt, "the unsupported-channel throw must come after the whatsapp branch, not before");
});

test("dormant until connected: a social reply with no connected Page fails honestly", () => {
  assert.match(DISPATCH, /pageConnectionForOutbound\(target\.organizationId, target\.channel\)/);
  assert.match(DISPATCH, /if \(!connection\)/);
  assert.match(DISPATCH, /cannot be sent/i);
});

test("the connected Page's id and token are resolved for the business, cross-tenant", () => {
  assert.match(CONNECTIONS, /export async function pageConnectionForOutbound/);
  assert.match(CONNECTIONS, /withAllTenants\(/);
  assert.match(
    CONNECTIONS,
    /where organization_id = \$1 and provider = \$2 and employee_id is null/,
    "the reply is sent AS the business's own connected Page"
  );
  assert.match(CONNECTIONS, /openToken\(/, "the page token is decrypted only to send");
});

test("the inbox send route dispatches by channel and stores the right message id", () => {
  assert.match(ROUTE, /sendReplyOnChannel\(/);
  assert.doesNotMatch(ROUTE, /sendWhatsAppText\(/, "the route must not hardcode WhatsApp any more");
  assert.match(ROUTE, /socialMessageId: dispatched\.socialMessageId/);
  assert.match(ROUTE, /waMessageId: dispatched\.waMessageId/);
});

test("the scheduled sweep sends on the conversation's channel too", () => {
  assert.match(SCHEDULED, /sendReplyOnChannel\(/);
  assert.doesNotMatch(SCHEDULED, /sendWhatsAppText\(/);
});

test("an outbound social message is stored with its mid, and status stays keyed on the wamid", () => {
  // social_message_id is written, but the 'queued' vs 'sent' status still keys on
  // wa_message_id alone — FB/IG has no delivery-receipt webhook wired, so a social
  // reply is 'sent' (accepted), never parked at 'queued' forever.
  assert.match(MESSAGES, /social_message_id/);
  assert.match(MESSAGES, /case when \$4::text is null then 'sent' else 'queued' end/);
});

test("the conversation lookup carries the channel and the social recipient a reply needs", () => {
  assert.match(CONVERSATIONS, /c\.channel/);
  assert.match(CONVERSATIONS, /ct\.external_id/);
  assert.match(CONVERSATIONS, /contactExternalId: row\.external_id/);
});
