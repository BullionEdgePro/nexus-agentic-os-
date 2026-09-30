// A customer's photo, voice note, document or button tap used to be thrown away
// before it was saved (`if (message.type !== "text") continue`). These run the
// real describer on Meta's payload shapes, then pin the pipeline wiring as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describeInboundMessage } from "../src/lib/inbound-media.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const PROC = read("apps", "api", "src", "queue", "processor.ts");
const ROUTE = read("apps", "api", "src", "routes", "conversations.ts");
const MESSAGES = read("packages", "db", "src", "messages.ts");
const INBOX = read("apps", "web", "app", "inbox", "page.tsx");

const base = { from: "971500000000", id: "wamid.x", timestamp: "1790000000" };
const d = (msg) => describeInboundMessage({ ...base, ...msg });

test("text still reads as itself, with no note for the AI", () => {
  assert.deepEqual(d({ type: "text", text: { body: "Is it in stock?" } }), {
    body: "Is it in stock?",
    attachment: null,
    aiNote: null,
  });
});

test("a photo keeps its caption and is marked as a file the AI cannot see", () => {
  const r = d({ type: "image", image: { id: "m1", mime_type: "image/jpeg", caption: "do you have this in blue?" } });
  assert.equal(r.body, "[Photo] do you have this in blue?");
  assert.equal(r.attachment, "image");
  assert.match(r.aiNote, /cannot see/);
  assert.match(r.aiNote, /Never describe or guess/);
  assert.equal(d({ type: "image", image: { id: "m1" } }).body, "[Photo]");
});

test("voice notes, audio, video, documents and stickers are all kept", () => {
  assert.equal(d({ type: "audio", audio: { id: "a", voice: true } }).body, "[Voice note]");
  assert.equal(d({ type: "audio", audio: { id: "a" } }).body, "[Audio]");
  assert.equal(d({ type: "video", video: { id: "v", caption: "look" } }).body, "[Video] look");
  const doc = d({ type: "document", document: { id: "f", filename: "Title deed.pdf" } });
  assert.equal(doc.body, "[Document: Title deed.pdf]");
  assert.equal(doc.attachment, "document");
  assert.equal(d({ type: "sticker", sticker: { id: "s" } }).attachment, "sticker");
});

test("a button tap is what the customer said, so an opt-out button still opts out", () => {
  const r = d({ type: "button", button: { text: "Stop promotions", payload: "STOP" } });
  assert.equal(r.body, "Stop promotions");
  assert.equal(r.attachment, null);
  assert.equal(r.aiNote, null);
  assert.equal(d({ type: "interactive", interactive: { type: "button_reply", button_reply: { id: "1", title: "Book a viewing" } } }).body, "Book a viewing");
  assert.equal(
    d({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "2", title: "Dubai Marina", description: "2 bed" } } }).body,
    "Dubai Marina (2 bed)"
  );
});

test("location and contact cards become readable lines", () => {
  assert.equal(
    d({ type: "location", location: { latitude: 25.0772, longitude: 55.1403, name: "Marina Walk" } }).body,
    "[Location: Marina Walk — 25.07720, 55.14030]"
  );
  assert.equal(
    d({ type: "contacts", contacts: [{ name: { formatted_name: "Sara" }, phones: [{ phone: "+971 50 111 2222" }] }] }).body,
    "[Contact card: Sara, +971 50 111 2222]"
  );
});

test("only a reaction is skipped; anything unknown is still recorded", () => {
  assert.equal(d({ type: "reaction", reaction: { message_id: "x", emoji: "👍" } }), null);
  const u = d({ type: "unsupported" });
  assert.ok(u && u.body.startsWith("["));
  assert.match(u.aiNote, /send it again/);
});

test("the pipeline no longer drops non-text messages", () => {
  assert.ok(!/if \(message\.type !== "text" \|\| !message\.text\) continue;/.test(PROC), "the old text-only filter is gone");
  const loop = PROC.slice(PROC.indexOf("export async function processInboundWebhookJob"));
  assert.match(loop, /const described = describeInboundMessage\(message\);\s+if \(!described\) continue;/);
  assert.match(loop, /processSingleTextMessage\(phoneNumberId, \{ \.\.\.message, text: \{ body: described\.body \} \}, change\)/);
  // The real type is stored, so the inbox can offer the file.
  assert.equal((PROC.match(/messageType: message\.type,/g) ?? []).length, 2);
  // The AI hears the attachment note; the stored body stays the label alone.
  assert.match(PROC, /text: withAttachmentNote\(message, text\.body\)/);
});

test("staff can open the file, only through the chat it belongs to", () => {
  assert.match(ROUTE, /conversationsRoute\.get\("\/:id\/messages\/:messageId\/media"/);
  const ref = MESSAGES.slice(MESSAGES.indexOf("export async function getInboundMediaRef"));
  assert.match(ref, /where m\.id = \$2 and m\.conversation_id = \$1 and m\.direction = 'inbound'/);
  assert.match(ROUTE, /"X-Content-Type-Options": "nosniff"/);
  assert.match(INBOX, /\{row\.message\.attachment \? <Attachment message=\{row\.message\} \/> : null\}/);
});

test("a message with no sender profile is still processed, not crashed on", () => {
  // Meta's "unsupported" messages (error 131051) arrive with a contact that has
  // no profile; reading profile.name without the ? failed the job 5 times.
  assert.match(PROC, /\?\.profile\?\.name;/);
  assert.ok(!/\)\?\.profile\.name;/.test(PROC), "no code line reads profile.name unguarded");
  const u = describeInboundMessage({ from: "971500000000", id: "w", timestamp: "1", type: "unsupported", errors: [{ code: 131051 }] });
  assert.ok(u && u.body.startsWith("["), "an unsupported message is still recorded");
});
