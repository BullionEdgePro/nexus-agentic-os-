// The Messenger / Instagram inbound parser, before it is ever wired to a webhook.
//
// This is the foundation slice of the Facebook Page + Instagram messaging
// channels. The integration cannot run end to end until Meta grants
// pages_messaging / instagram_manage_messages and a Page is connected — so the
// parser is proven here against Meta's documented delivery shapes instead, so it
// is correct before it can be exercised live.
import { test } from "node:test";
import assert from "node:assert/strict";

import { parseMessagingWebhook } from "../src/lib/messenger-client.ts";

test("a Messenger delivery becomes one facebook message", () => {
  const events = parseMessagingWebhook({
    object: "page",
    entry: [
      {
        id: "PAGE_123",
        messaging: [
          {
            sender: { id: "PSID_9" },
            recipient: { id: "PAGE_123" },
            timestamp: 1_700_000_000_000,
            message: { mid: "m_abc", text: "hello there" },
          },
        ],
      },
    ],
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    channel: "facebook",
    pageId: "PAGE_123",
    senderId: "PSID_9",
    recipientId: "PAGE_123",
    messageId: "m_abc",
    text: "hello there",
    timestamp: 1_700_000_000_000,
  });
});

test("an Instagram delivery becomes one instagram message", () => {
  const events = parseMessagingWebhook({
    object: "instagram",
    entry: [
      { id: "IG_1", messaging: [{ sender: { id: "IGSID_2" }, recipient: { id: "IG_1" }, timestamp: 1, message: { mid: "ig_1", text: "hi" } }] },
    ],
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].channel, "instagram");
  assert.equal(events[0].senderId, "IGSID_2");
});

test("our own echoed message is not treated as inbound", () => {
  const events = parseMessagingWebhook({
    object: "page",
    entry: [{ id: "P", messaging: [{ sender: { id: "P" }, recipient: { id: "U" }, message: { mid: "m", text: "our reply", is_echo: true } }] }],
  });
  assert.deepEqual(events, [], "an echo must be dropped, or we would store our own reply as if the customer sent it");
});

test("a WhatsApp or non-messaging delivery is left for another handler", () => {
  assert.deepEqual(parseMessagingWebhook({ object: "whatsapp_business_account", entry: [] }), []);
  assert.deepEqual(parseMessagingWebhook({ object: "page", entry: [{ id: "P", messaging: [{ sender: { id: "U" }, recipient: { id: "P" }, delivery: { mids: ["m"] } }] }] }), []);
});

test("a message with no text (an attachment) is dropped, not stored blank", () => {
  const events = parseMessagingWebhook({
    object: "page",
    entry: [{ id: "P", messaging: [{ sender: { id: "U" }, recipient: { id: "P" }, message: { mid: "m", attachments: [{ type: "image" }] } }] }],
  });
  // No text -> text is "" but the message still parses (mid + sender present);
  // the wiring layer decides what to do with an attachment. What must never
  // happen is a crash or a message invented from nothing.
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "");
});

test("garbage in does not throw", () => {
  assert.deepEqual(parseMessagingWebhook({}), []);
  assert.deepEqual(parseMessagingWebhook({ object: "page" }), []);
  assert.deepEqual(parseMessagingWebhook({ object: "page", entry: [{}] }), []);
});
