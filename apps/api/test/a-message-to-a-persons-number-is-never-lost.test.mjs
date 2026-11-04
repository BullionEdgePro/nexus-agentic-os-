// A message to a person's own number is never lost (audit, 4 Nov 2026).
//
// Since the shared line was switched off on 6 Oct, every live WhatsApp message
// arrives on a person's own number — a staff member's or an admin's seat — and
// takes handleStaffNumberMessage, not the business-number pipeline. Two things
// that path missed, both found in production:
//
// - STOP. Bulk offers go out from admins' numbers with a Stop button; the tap
//   came back on that number and nothing recorded it, so the next campaign
//   reached the customer again. The Arabic button ("إيقاف") was not even a
//   word the opt-out check knew.
// - A removed person's number. Deactivating someone leaves their number
//   connected at Meta; the lookup asks only for active staff, so the customer's
//   message — and the receipts for what was sent from that number — were
//   dropped with a warning (22 in one day on 3-4 Nov). Now they land in that
//   person's business, unassigned, where an admin sees them.
//
// Runs the real inbound job against the throwaway Postgres; Redis (the
// per-customer lock, the inbox stream) and Meta (fetch) are stood in.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "95959595-0000-4000-8000-000000000001";
const ADMIN_SEAT = "95959595-0000-4000-8000-0000000000e1";
const REMOVED = "95959595-0000-4000-8000-0000000000e2";
const SEAT_NUMBER = "950001";
const REMOVED_NUMBER = "950002";

let owner;
let dbTurn;
let processor;
const published = [];
const sentToMeta = [];

mock.module(new URL("../src/queue/conversation-lock.ts", import.meta.url).href, {
  namedExports: {
    withConversationLock: async (_phoneNumberId, _contactWaId, fn) => fn(),
    ConversationBusyError: class ConversationBusyError extends Error {},
  },
});
mock.module(new URL("../src/lib/pubsub.ts", import.meta.url).href, {
  namedExports: {
    publishInboxEvent: async (event) => void published.push(event),
    subscribeToInboxEvents: () => () => undefined,
  },
});
// Receipts also note test sends and payment refusals, both kept in Redis.
mock.module(new URL("../src/lib/campaign-test-status.ts", import.meta.url).href, {
  namedExports: {
    testStateAdvances: () => true,
    noteTestSend: async () => undefined,
    readTestSend: async () => null,
    recordTestSendReceipt: async () => false,
  },
});
mock.module(new URL("../src/lib/payment-refusal.ts", import.meta.url).href, {
  namedExports: {
    notePaymentRefusal: async () => undefined,
    clearPaymentRefusal: async () => undefined,
    readPaymentRefusal: async () => null,
  },
});

const realFetch = globalThis.fetch;

before(async () => {
  if (db.skip) return;
  process.env.META_ACCESS_TOKEN = "probe-token-never-sent"; // fetch is replaced below
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("graph.facebook.com")) {
      sentToMeta.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ messages: [{ id: `wamid.pn.out.${sentToMeta.length}` }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 503 }); // lead scoring and the like: best effort, refused fast
  };
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'pn-org', 'Probe Numbers', '950009', '850009', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, whatsapp_phone_number_id, is_active)
     values ($1, $3, 'PN1', 'Probe Admin', $4, true), ($2, $3, 'PN2', 'Probe Leaver', $5, false)`,
    [ADMIN_SEAT, REMOVED, ORG, SEAT_NUMBER, REMOVED_NUMBER]
  );
  process.env.DATABASE_URL = APP_URL;
  processor = await import("../src/queue/processor.ts");
});

after(async () => {
  globalThis.fetch = realFetch;
  if (db.skip) return;
  try {
    for (const table of ["messages", "lead_assessments", "conversation_events", "conversation_custody", "conversations", "contacts", "employees"]) {
      await owner.query(`delete from ${table} where organization_id = $1`, [ORG]).catch(() => undefined);
    }
    await owner.query(`delete from organizations where id = $1`, [ORG]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    const lib = await import("@nexus/db").catch(() => null);
    if (lib) await lib.getPool().end();
  }
});

/** One webhook delivery, as Meta sends it, carrying one customer message. */
const inbound = (phoneNumberId, from, message) => ({
  data: {
    phoneNumberId,
    payload: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "850009",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "971500000000", phone_number_id: phoneNumberId },
                contacts: [{ wa_id: from, profile: { name: "Probe Customer" } }],
                messages: [{ from, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
              },
            },
          ],
        },
      ],
    },
  },
});
const receipt = (phoneNumberId, wamid, status) => ({
  data: {
    phoneNumberId,
    payload: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "850009",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "971500000000", phone_number_id: phoneNumberId },
                statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: "971597000201" }],
              },
            },
          ],
        },
      ],
    },
  },
});
const optedOut = async (waId) =>
  (await owner.query(`select reengagement_opted_out from contacts where organization_id = $1 and wa_id = $2`, [ORG, waId])).rows[0]
    ?.reengagement_opted_out;

test("a customer who taps the Arabic Stop on an admin's number is opted out, and told so in Arabic", db, async () => {
  sentToMeta.length = 0;
  await processor.processInboundWebhookJob(
    inbound(SEAT_NUMBER, "971597000101", { id: "wamid.pn.in.1", type: "button", button: { text: "إيقاف", payload: "إيقاف" } })
  );
  assert.equal(await optedOut("971597000101"), true, "the Stop tap was not recorded");
  const confirmation = sentToMeta.find((send) => send.body.to === "971597000101");
  assert.ok(confirmation, "the customer was not told it worked");
  assert.match(confirmation.url, new RegExp(`/${SEAT_NUMBER}/messages$`), "the confirmation left from another number");
  assert.match(confirmation.body.text.body, /[؀-ۿ]/, "an Arabic Stop was answered in English");
  // Still a message in the person's inbox: they see the customer asked.
  const recorded = await owner.query(`select count(*)::int as n from messages where organization_id = $1 and wa_message_id = 'wamid.pn.in.1'`, [ORG]);
  assert.equal(recorded.rows[0].n, 1);
});

test("an English Stop on an admin's number is honoured too", db, async () => {
  sentToMeta.length = 0;
  await processor.processInboundWebhookJob(
    inbound(SEAT_NUMBER, "971597000102", { id: "wamid.pn.in.2", type: "button", button: { text: "Stop", payload: "Stop" } })
  );
  assert.equal(await optedOut("971597000102"), true);
  assert.match(sentToMeta.find((send) => send.body.to === "971597000102")?.body.text.body ?? "", /not receive any more promotional messages/);
});

test("an ordinary message on an admin's number opts nobody out and sends nothing", db, async () => {
  sentToMeta.length = 0;
  await processor.processInboundWebhookJob(
    inbound(SEAT_NUMBER, "971597000103", { id: "wamid.pn.in.3", type: "text", text: { body: "Can you stop by on Thursday?" } })
  );
  assert.equal(await optedOut("971597000103"), false);
  assert.equal(sentToMeta.length, 0);
});

test("a message to a removed person's number lands in their business, unassigned, and the inbox hears of it", db, async () => {
  published.length = 0;
  await processor.processInboundWebhookJob(
    inbound(REMOVED_NUMBER, "971597000201", { id: "wamid.pn.in.4", type: "text", text: { body: "Hello, are you there?" } })
  );
  const row = (
    await owner.query(
      `select m.conversation_id, c.employee_id from messages m join conversations c on c.id = m.conversation_id
        where m.organization_id = $1 and m.wa_message_id = 'wamid.pn.in.4'`,
      [ORG]
    )
  ).rows[0];
  assert.ok(row, "the customer's message was dropped");
  assert.equal(row.employee_id, null, "it was handed to the person who was removed");
  assert.ok(
    published.some((event) => event.type === "message" && event.organizationId === ORG && event.conversationId === row.conversation_id),
    "nobody's inbox was told"
  );
});

test("a receipt for something sent from a removed person's number still updates it", db, async () => {
  const { id: conversation, contact_id: contact } = (
    await owner.query(
      `select id, contact_id from conversations where organization_id = $1 and contact_id = (select id from contacts where organization_id = $1 and wa_id = '971597000201')`,
      [ORG]
    )
  ).rows[0];
  await owner.query(
    `insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, status, wa_message_id)
     values ($1, $2, $3, 'outbound', 'human_agent', 'Earlier reply', 'sent', 'wamid.pn.out.removed')`,
    [ORG, conversation, contact]
  );
  await processor.processInboundWebhookJob(receipt(REMOVED_NUMBER, "wamid.pn.out.removed", "delivered"));
  const status = (await owner.query(`select status from messages where wa_message_id = 'wamid.pn.out.removed'`)).rows[0].status;
  assert.equal(status, "delivered", "the receipt was dropped as unmapped");
});

test("on a business's number, STOP is honoured even while a person holds the chat", async () => {
  // Any staff reply pauses the AI and holds the chat for 24 hours; the opt-out
  // check sat after the "stood down" return, so a STOP then was never recorded.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/queue/processor.ts", import.meta.url), "utf8");
  const answer = source.slice(source.indexOf("async function answerOneMessage("));
  const optOut = answer.indexOf("if (looksLikeAnOptOut(text.body))");
  const stoodDown = answer.indexOf("if (isHumanHandoff || aiPaused)");
  assert.ok(optOut > 0 && stoodDown > 0, "both steps are there");
  assert.ok(optOut < stoodDown, "STOP is checked only after the agent stands down for a held chat");
});

test("a WhatsApp reply outside the 24-hour window is refused in words, not shown as sent", async () => {
  // Meta accepts it with a wamid and refuses it later (131047), so the inbox
  // showed a tick, paused the AI for 24 hours, and the customer got nothing.
  const { readFileSync } = await import("node:fs");
  const route = readFileSync(new URL("../src/routes/conversations.ts", import.meta.url), "utf8");
  const reply = route.slice(route.indexOf('conversationsRoute.post("/:id/messages"'));
  const check = reply.indexOf("openWindowConversations(");
  assert.ok(check > 0 && check < reply.indexOf("sendReplyOnChannel("), "the window is checked before sending");
  assert.match(reply.slice(0, reply.indexOf("sendReplyOnChannel(")), /return c\.json\(\{ error: OUTSIDE_THE_WINDOW \}, 409\)/);
  assert.match(route, /within 24 hours of the customer's last message/);
});
