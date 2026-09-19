// The receiving half of the Facebook Page + Instagram channels.
//
// Slice 3 wires slice 1's parser and slice 2's identity model to the live Meta
// webhook: a Page/IG delivery becomes a contact, a conversation on the right
// channel, and a message in the inbox — WITHOUT composing a reply (that needs
// Meta App Review and a page token) and WITHOUT inventing a business (dormant
// until a Page is connected). The correctness lives in the SQL and the control
// flow — dedup, channel, the dormant drop, per-event isolation — so this pins
// those as text, the way the rest of the channel suite does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const MIGRATION = read("packages", "db", "migrations", "089-a-social-message-has-an-id-too.sql");
const IDENTITY = read("packages", "db", "src", "social-identity.ts");
const CONNECTIONS = read("packages", "db", "src", "social-connections.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "social-processor.ts");

test("a redelivered message is stored once — dedup on Meta's mid", () => {
  assert.match(
    MIGRATION,
    /create\s+unique\s+index[\s\S]*social_message_id[\s\S]*where\s+social_message_id\s+is\s+not\s+null/i,
    "the mid must be a partial unique key, exactly like wa_message_id / email_message_id"
  );
  assert.match(
    IDENTITY,
    /on conflict \(social_message_id\) where social_message_id is not null do nothing/,
    "insertInboundSocialMessage must no-op on a redelivery"
  );
  // The new id is returned ONLY on a real insert, so the caller publishes once.
  assert.match(IDENTITY, /returning id/);
});

test("an inbound social message is recorded as the contact speaking, as text", () => {
  assert.match(IDENTITY, /direction, sender_type/);
  assert.match(IDENTITY, /'inbound', 'contact', 'text'/, "inbound, from the contact, text — same as a WhatsApp inbound");
});

test("a conversation is found or created ON THE RIGHT CHANNEL, not folded into WhatsApp", () => {
  assert.match(
    IDENTITY,
    /from conversations[\s\S]*where organization_id = \$1 and contact_id = \$2 and channel = \$3/,
    "the lookup must be scoped by channel or a Messenger thread would attach to a WhatsApp conversation"
  );
  assert.match(IDENTITY, /insert into conversations \(organization_id, contact_id, channel, status\)/);
});

test("the Page is resolved to its business across tenants, deliberately", () => {
  assert.match(CONNECTIONS, /export async function organizationForConnectedPage/);
  assert.match(CONNECTIONS, /withAllTenants\(/, "a page id is a routing key, not tenant data — the step out of RLS must be explicit");
  assert.match(
    CONNECTIONS,
    /provider in \('facebook', 'instagram'\) and external_id = \$1/,
    "resolve by the connected Page/IG id"
  );
});

test("dormant until a Page is connected: an unmapped delivery is dropped, not errored", () => {
  assert.match(PROCESSOR, /organizationForConnectedPage\(event\.pageId\)/);
  // The null branch must return without throwing (a throw would make BullMQ retry
  // forever a delivery that can never be filed until the connect flow exists).
  assert.match(PROCESSOR, /if \(!organizationId\)/);
  assert.match(PROCESSOR, /dropped/i);
  assert.doesNotMatch(PROCESSOR, /sendPageMessage/, "slice 3 ingests only — it must not send a reply");
});

test("one malformed delivery cannot force the whole webhook to retry", () => {
  // Each event is isolated, exactly as the WhatsApp processor isolates each
  // message in a batch.
  assert.match(PROCESSOR, /for \(const event of events\)/);
  assert.match(PROCESSOR, /try \{[\s\S]*ingestOneSocialMessage\(event\)[\s\S]*\} catch/);
});

test("an attachment with no text is skipped, never filed as a blank message", () => {
  assert.match(PROCESSOR, /if \(!event\.text\)/);
});

test("the inbox is told only when a row was actually written", () => {
  // publishInboxEvent sits after the `if (!filed) return`, so a redelivery
  // (messageId null) publishes nothing.
  const filedGuard = PROCESSOR.indexOf("if (!filed) return");
  const publishCall = PROCESSOR.indexOf("await publishInboxEvent");
  assert.ok(filedGuard !== -1 && publishCall > filedGuard, "the inbox event must come after the redelivery guard");
});
