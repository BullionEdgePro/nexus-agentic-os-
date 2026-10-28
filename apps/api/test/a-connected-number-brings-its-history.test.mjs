/**
 * Staff connected their WhatsApp Business app numbers and found none of their
 * past chats (28 Oct 2026). Meta sends them only if the platform asks within
 * 24 hours of connecting, and delivers them as `history` webhooks the processor
 * used to ignore. These pin the ask, the import, and the two refusals a person
 * must be told about — and, beside them, the payment block that refused 30 of
 * 30 campaign messages the same day.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { historyMessageBody, historyMessageStatus, HISTORY_SHARING_OFF } from "../src/lib/whatsapp-history.ts";
import { healthFrom } from "../src/lib/whatsapp-client.ts";
import { explainSendError } from "../src/lib/send-errors.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...path) => readFileSync(join(here, "..", "src", ...path), "utf8");
const db = (...path) => readFileSync(join(here, "..", "..", "..", "packages", "db", "src", ...path), "utf8");

test("the connect asks for the history the moment the number is theirs", () => {
  const route = src("routes", "connections.ts");
  const connected = route.indexOf("assignEmployeeWhatsAppNumber(employeeId");
  const asked = route.indexOf("await requestChatHistory(connectedPhoneNumberId, businessToken)");
  assert.ok(connected > 0 && asked > connected, "history is requested after the number is assigned");
});

test("contacts are asked for before history, as Meta orders them, and neither throws", () => {
  const lib = src("lib", "whatsapp-history.ts");
  assert.ok(lib.indexOf('"smb_app_state_sync"') < lib.indexOf('"history", accessToken'));
  assert.match(src("lib", "whatsapp-client.ts"), /\/smb_app_data`/);
});

test("the processor imports app sync without letting it cost the live messages beside it", () => {
  const processor = src("queue", "processor.ts");
  assert.match(processor, /try \{\s*await processAppSync\(phoneNumberId, change\);\s*\} catch/);
});

test("imported history keeps its own time, is deduped, is never answered, and files new chats as resolved", () => {
  const writer = db("messages.ts");
  const fn = writer.slice(writer.indexOf("export async function importHistoryThread"), writer.indexOf("export async function nameContactIfUnnamed"));
  assert.match(fn, /created_at\)/);
  assert.match(fn, /on conflict \(wa_message_id\) where wa_message_id is not null do nothing/);
  assert.match(fn, /'resolved', \$4\)/);
  assert.doesNotMatch(fn, /publishInboxEvent|Queue\(|\.add\(|runAgent|dispatch/);
  assert.match(fn, /coalesce\(contacts\.display_name, excluded\.display_name\)/, "a name typed in Nexus wins");
});

test("sharing turned off in the app is recognised and said", () => {
  assert.equal(HISTORY_SHARING_OFF, 2593109);
  assert.match(src("lib", "whatsapp-history.ts"), /state: sharingOff \? "declined"/);
});

test("history statuses and bodies read as the inbox spells them", () => {
  assert.equal(historyMessageStatus("READ"), "read");
  assert.equal(historyMessageStatus("PLAYED"), "read");
  assert.equal(historyMessageStatus("DELIVERED"), "delivered");
  assert.equal(historyMessageStatus("ERROR"), "failed");
  assert.equal(historyMessageStatus(undefined), "sent");
  assert.equal(historyMessageBody({ type: "text", text: { body: "Thanks!" } }), "Thanks!");
  assert.match(historyMessageBody({ type: "media_placeholder" }), /not included/);
});

test("a BLOCKED health answer names the reason; an available one has none", () => {
  const blocked = healthFrom({
    can_send_message: "BLOCKED",
    entities: [
      { entity_type: "PHONE_NUMBER", can_send_message: "AVAILABLE" },
      {
        entity_type: "WABA",
        can_send_message: "BLOCKED",
        errors: [{ error_code: 141006, error_description: "There was an error with your payment method.", possible_solution: "Add a new payment method." }],
      },
    ],
  });
  assert.deepEqual(blocked.problem, {
    code: 141006,
    description: "There was an error with your payment method.",
    solution: "Add a new payment method.",
  });
  assert.equal(healthFrom({ can_send_message: "AVAILABLE", entities: [] }).problem, null);
  assert.equal(healthFrom(undefined), null);
});

test("131042 reads as the payment problem it is, in both shapes Meta sends it", () => {
  const receipt =
    "131042: Business eligibility payment issue: Message failed to send because your WhatsApp Business account currency is not configured.";
  assert.match(explainSendError(receipt), /no payment method/);
  assert.match(explainSendError('{"error":{"code":131042,"message":"Business eligibility payment issue"}}'), /billing_hub/);
});
