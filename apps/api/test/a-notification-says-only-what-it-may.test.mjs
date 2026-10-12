// A notification says who and where, and the words only if allowed (spec
// 2026-10-09-nexus-mobile-app-design.md, "Push notifications", content).
// A lock screen is read by whoever is near the phone, so a customer's message
// text appears on it only when the person turned previews on for THAT device.
// The payload builder runs for real; the sender's status mapping is pinned as
// text, because exercising it needs a live push service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildMessagePayload, buildPlatformPayload } from "../src/lib/web-push.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SENDER = readFileSync(join(here, "..", "src", "lib", "web-push.ts"), "utf8").replace(/\r\n/g, "\n");

const base = { conversationId: "c1", customer: "Aisha", business: "Zipicka", kind: "message", text: "Is the vanity set in stock?" };

test("without previews it says who and where, never what", () => {
  const p = buildMessagePayload(base, false);
  assert.equal(p.title, "Aisha · Zipicka");
  assert.equal(p.body, "sent a message");
  assert.ok(!p.body.includes("vanity"), "the customer's words stay off the lock screen");
  assert.equal(p.tag, "conv-c1", "repeat messages replace each other");
  assert.equal(p.url, "/inbox?conversation=c1", "the link the inbox already opens (Task 4 ruling)");
});

test("an assignment says so", () => {
  assert.equal(buildMessagePayload({ ...base, kind: "assigned" }, false).body, "was assigned to you");
});

test("with previews the words are shown, plain and short", () => {
  const p = buildMessagePayload({ ...base, text: "<b>Hi</b> " + "x".repeat(300) }, true);
  assert.ok(!/[<>]/.test(p.body), "no markup reaches the notification");
  assert.ok(p.body.startsWith("Hi x"), "the text itself, tags removed");
  assert.ok(p.body.length <= 120);
  assert.ok(p.body.endsWith("…"));
});

test("previews on with nothing to show still says something", () => {
  assert.equal(buildMessagePayload({ ...base, text: null }, true).body, "sent a message");
  assert.equal(buildMessagePayload({ ...base, text: "  <img>  " }, true).body, "sent a message");
});

test("a platform problem opens the owner's deck, one alert per problem", () => {
  const p = buildPlatformPayload("Inbound messages are stalled");
  assert.equal(p.url, "/deck");
  assert.equal(p.tag, "platform-inbound-messages-are-stalled");
  assert.match(p.body, /Inbound messages are stalled/);
});

test("a device the push service has forgotten is reported gone, and nobody waits on a slow one", () => {
  assert.match(SENDER, /404/);
  assert.match(SENDER, /410/);
  assert.match(SENDER, /"gone"/);
  assert.match(SENDER, /timeout: 10[_]?000|AbortSignal\.timeout\(10[_]?000\)/);
});
