// A campaign said 'sent' and meant what 'sent' used to mean on a reply.
//
// `broadcast_recipients.status` has allowed pending / sent / delivered / failed
// since the table was written, and nothing has ever written 'delivered'. The
// send path marks a recipient 'sent' the moment the Graph API returns 2xx — and
// 2xx means ACCEPTED. That is the conflation migration 048 removed from replies,
// left in place for campaigns.
//
// It matters MORE here. A reply goes to somebody who wrote thirty seconds ago,
// so the session window is open and delivery is near certain. A campaign goes by
// definition to people who have NOT written in 24 hours — the population most
// likely to have changed number, blocked the business, or never opted in. Those
// are the sends Meta accepts and then drops.
//
// Written while `broadcast_recipients` has ZERO rows. Every other defect fixed
// this session was found after it cost a customer something; this one was found
// by reading the send path, and closed before the first campaign.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DELIVERY_STATUS_LADDER } from "@nexus/shared";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const BROADCASTS = read("packages", "db", "src", "broadcasts.ts");
const SENDER = read("apps", "api", "src", "queue", "broadcast-processor.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const MIGRATION = read("packages", "db", "migrations", "051-broadcast-receipts.sql");

test("the campaign send stops throwing away the receipt it already had", () => {
  // sendWhatsAppTemplate was changed to return the wamid on 17 August and this
  // caller ignored it — the reply path was wired and the campaign path was not.
  assert.match(SENDER, /const waMessageId = await sendWhatsAppTemplate\(/);
  assert.match(SENDER, /updateBroadcastRecipientStatus\(recipientId, "sent", waMessageId\)/);
  assert.match(MIGRATION, /add column if not exists wa_message_id text/);
});

test("a receipt is tried against BOTH tables, because a wamid belongs to one", () => {
  // A reply lands in `messages`; a campaign send lands in `broadcast_recipients`
  // and has no message row at all. Trying only the first would leave every
  // campaign receipt matching nothing — and "0 rows updated" is the same answer
  // a duplicate webhook gives, so it would never have looked wrong.
  const fn = PROCESSOR.slice(
    PROCESSOR.indexOf("async function processDeliveryStatuses"),
    PROCESSOR.indexOf("function describeStatusError")
  );
  assert.match(fn, /recordDeliveryStatus\(/);
  assert.match(fn, /recordBroadcastDelivery\(/);
  assert.match(fn, /const moved = movedMessage \|\| movedRecipient/);
});

test("'queued' is narrowed away rather than cast away", () => {
  // MessageStatus includes 'queued', which Meta never reports and this table has
  // no room for. A cast would have compiled and produced an UPDATE that matches
  // nothing — the failure being fixed, reintroduced by the fix.
  const fn = PROCESSOR.slice(PROCESSOR.indexOf("async function processDeliveryStatuses"));
  assert.match(fn, /status\.status === "queued"\s*\n?\s*\? Promise\.resolve\(false\)/);
  assert.ok(!/as "sent" \| "delivered"/.test(fn), "no cast around the status vocabulary");
});

test("a read receipt becomes 'delivered', because this table has no 'read'", () => {
  // Not a fudge: being read is proof of delivery, and this table's question is
  // whether the campaign arrived rather than whether it was opened. Inventing a
  // 'read' state would mean a migration on every consumer of the column.
  assert.match(BROADCASTS, /input\.status === "read" \? "delivered" : input\.status/);
});

test("the two ladders are separate on purpose", () => {
  // messages runs queued → sent → delivered → read. broadcast_recipients has
  // neither end of that. Sharing the constant would let a value through that
  // this table's own check constraint rejects, and the symptom would be an
  // UPDATE silently matching nothing.
  assert.match(BROADCASTS, /const BROADCAST_STATUS_LADDER = \["pending", "sent", "delivered"\] as const/);
  assert.deepEqual([...DELIVERY_STATUS_LADDER], ["queued", "sent", "delivered", "read"]);
  // Comments stripped: the doc comment above BROADCAST_STATUS_LADDER explains
  // why it is not the shared one, and a plain search finds the explanation and
  // reports the borrowing it warns against.
  const code = BROADCASTS.replace(/^[ 	]*\/\*[\s\S]*?\*\//gm, " ");
  assert.ok(
    !/DELIVERY_STATUS_LADDER/.test(code),
    "broadcasts must not borrow the messages ladder"
  );
});

test("a late receipt cannot walk a campaign recipient backwards", () => {
  // Same guard as messages, in the WHERE clause rather than a read-then-write,
  // because Meta does not promise order and two receipts can race.
  assert.match(
    BROADCASTS,
    /coalesce\(array_position\(\$4::text\[\], \$2\), 0\)\s*>\s*coalesce\(array_position\(\$4::text\[\], status\), 0\)/
  );
  assert.match(BROADCASTS, /\(\$2 = 'failed' and status <> 'failed'\)/);
});

test("Meta's reason survives on the recipient row", () => {
  // On this path it is the most useful field on the table: "re-engagement
  // message" means the template went out outside the window, which is a mistake
  // about the CAMPAIGN rather than about the recipient.
  assert.match(MIGRATION, /add column if not exists delivery_error text/);
  assert.match(BROADCASTS, /delivery_error = coalesce\(\$3, delivery_error\)/);
});
