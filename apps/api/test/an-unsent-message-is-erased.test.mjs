// A customer who unsends an Instagram or Messenger message takes it back, and
// Meta's Platform Terms require the app to delete it too. Before 2026-10-02 an
// unsend parsed as a blank message and was dropped, so Nexus kept the words.
// The parser runs for real; the erase wiring is pinned as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseMessagingWebhook } from "../src/lib/messenger-client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const PROC = read("apps", "api", "src", "queue", "social-processor.ts");
const DB = read("packages", "db", "src", "social-identity.ts");
const HOOK = read("apps", "api", "src", "webhook", "whatsapp.ts");

const delivery = (message) => ({
  object: "instagram",
  entry: [{ id: "17841400000000000", messaging: [{ sender: { id: "IGSID1" }, recipient: { id: "17841400000000000" }, timestamp: 1790000000000, message }] }],
});

test("an unsend is parsed as an erase, with no text", () => {
  const [e] = parseMessagingWebhook(delivery({ mid: "m_1", is_deleted: true }));
  assert.equal(e.unsent, true);
  assert.equal(e.text, "");
  assert.equal(e.messageId, "m_1");
});

test("an ordinary message is not an unsend", () => {
  const [e] = parseMessagingWebhook(delivery({ mid: "m_2", text: "hi" }));
  assert.equal(e.unsent, false);
  assert.equal(e.text, "hi");
});

test("the processor erases before the no-text drop could swallow the unsend", () => {
  const fn = PROC.slice(PROC.indexOf("async function ingestOneSocialMessage("));
  const unsentAt = fn.indexOf("if (event.unsent)");
  const dropAt = fn.indexOf("if (!event.text)");
  assert.ok(unsentAt > -1 && dropAt > -1 && unsentAt < dropAt);
  assert.match(PROC, /eraseUnsentSocialMessage\(organizationId, event\.messageId\)/);
});

test("only that business's inbound message is erased, and its words are gone", () => {
  const fn = DB.slice(DB.indexOf("export async function eraseUnsentSocialMessage("));
  assert.match(fn, /where organization_id = \$1 and social_message_id = \$2 and direction = 'inbound'/);
  assert.match(fn, /set body = \$3/);
  assert.match(DB, /UNSENT_MESSAGE_BODY = "\[The customer unsent this message\]"/);
});

test("an unsend is queued under its own job id, not as a duplicate of the message", () => {
  // Both deliveries carry the same mid; keyed on the bare mid, BullMQ dropped the
  // unsend as a duplicate job and the erase never ran (found live 2026-10-02).
  assert.match(HOOK, /first\.is_deleted === true \? first\.mid \+ "-unsent" : first\.mid/);
  assert.match(HOOK, /jobId: \(entry\?\.id \?\? "social"\) \+ "-" \+ jobKey/);
});
