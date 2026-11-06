// A customer with a WhatsApp username is not lost (6 Nov 2026).
//
// WhatsApp lets people use a username instead of showing their number, and
// Meta then sends their messages with NO `from`: the sender is a
// business-scoped user id (BSUID, e.g. "AE.1234...") in `from_user_id`, and
// the contact block carries `user_id` and `profile.username` with no `wa_id`.
// Every part of Nexus read `from` as the customer's number. On 5 Nov at 02:06
// UTC one such customer's message failed five times on the contacts identity
// check (a contact with no number) and was lost.
//
// Now the sender is the number when there is one and the BSUID when there is
// not; a reply to a BSUID goes in `recipient` rather than `to` (Meta's
// "Business-scoped user IDs" page); an echo to such a customer reads
// `to_user_id`; and a message naming nobody at all is skipped, not retried.
//
// Runs the real inbound job against the throwaway Postgres; Redis and Meta are
// stood in, as in a-message-to-a-persons-number-is-never-lost.test.mjs.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "96969696-0000-4000-8000-000000000001";
const SEAT = "96969696-0000-4000-8000-0000000000e1";
const SEAT_NUMBER = "960001";
const BSUID = "AE.13491208655302741918";

let owner;
let dbTurn;
let processor;
const sentToMeta = [];

mock.module(new URL("../src/queue/conversation-lock.ts", import.meta.url).href, {
  namedExports: {
    withConversationLock: async (_phoneNumberId, _contactWaId, fn) => fn(),
    ConversationBusyError: class ConversationBusyError extends Error {},
  },
});
mock.module(new URL("../src/lib/pubsub.ts", import.meta.url).href, {
  namedExports: { publishInboxEvent: async () => undefined, subscribeToInboxEvents: () => () => undefined },
});
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
process.env.META_ACCESS_TOKEN = "probe-token-never-sent"; // fetch is replaced below
globalThis.fetch = async (url, init) => {
  if (String(url).includes("graph.facebook.com")) {
    sentToMeta.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.un.out.${sentToMeta.length}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 503 });
};

const shared = await import("@nexus/shared");

test("a username id is told from a number", () => {
  // Which customer a message is filed as is customerFiledAs's, with the number
  // behind a username id kept (one-customer-one-contact.test.mjs).
  assert.equal(shared.isBusinessScopedUserId(BSUID), true);
  assert.equal(shared.isBusinessScopedUserId("US.ENT.11815799212886844830"), true, "a parent id too");
  assert.equal(shared.isBusinessScopedUserId("971501234567"), false);
});

test("a reply to a username id goes in `recipient`; to a number, in `to`", async () => {
  const { sendWhatsAppText, sendWhatsAppTemplate } = await import("../src/lib/whatsapp-client.ts");
  sentToMeta.length = 0;
  await sendWhatsAppText(SEAT_NUMBER, BSUID, "Hello");
  await sendWhatsAppText(SEAT_NUMBER, "971501234567", "Hello");
  await sendWhatsAppTemplate(SEAT_NUMBER, BSUID, "hello_world", "en");
  assert.equal(sentToMeta[0].body.recipient, BSUID);
  assert.equal("to" in sentToMeta[0].body, false, "a username id must not go in `to`");
  assert.equal(sentToMeta[1].body.to, "971501234567");
  assert.equal("recipient" in sentToMeta[1].body, false);
  assert.equal(sentToMeta[2].body.recipient, BSUID);
});

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'un-org', 'Probe Usernames', '960009', '860009', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, whatsapp_phone_number_id, is_active)
     values ($1, $2, 'UN1', 'Probe Seat', $3, true)`,
    [SEAT, ORG, SEAT_NUMBER]
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

/** One delivery shaped as the one lost on 5 Nov: no `from`, no `wa_id`. */
const fromUsername = (value) => ({
  data: {
    phoneNumberId: SEAT_NUMBER,
    payload: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "860009",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "971500000000", phone_number_id: SEAT_NUMBER },
                ...value,
              },
            },
          ],
        },
      ],
    },
  },
});

test("a username customer's message is saved, under their name", db, async () => {
  await processor.processInboundWebhookJob(
    fromUsername({
      contacts: [{ user_id: BSUID, profile: { name: "Layla", username: "@layla.homes" } }],
      messages: [
        {
          from_user_id: BSUID,
          id: "wamid.un.in.1",
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: "text",
          text: { body: "Is the 2-bedroom still available?" },
        },
      ],
    })
  );
  const contact = await owner.query(`select wa_id, display_name from contacts where organization_id = $1`, [ORG]);
  assert.deepEqual(contact.rows, [{ wa_id: BSUID, display_name: "Layla" }]);
  const saved = await owner.query(`select body, direction from messages where organization_id = $1 and wa_message_id = 'wamid.un.in.1'`, [ORG]);
  assert.equal(saved.rows[0]?.body, "Is the 2-bedroom still available?");
});

test("with no profile name, the username names them", db, async () => {
  const other = "AE.99999999999999999999";
  await processor.processInboundWebhookJob(
    fromUsername({
      contacts: [{ user_id: other, profile: { username: "@quiet.buyer" } }],
      messages: [{ from_user_id: other, id: "wamid.un.in.2", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hi" } }],
    })
  );
  const contact = await owner.query(`select display_name from contacts where organization_id = $1 and wa_id = $2`, [ORG, other]);
  assert.equal(contact.rows[0]?.display_name, "@quiet.buyer");
});

test("what the person sends from their phone to a username customer is mirrored", db, async () => {
  await processor.processInboundWebhookJob(
    fromUsername({
      message_echoes: [
        { from: "971500000000", to_user_id: BSUID, id: "wamid.un.echo.1", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Yes, viewing on Saturday?" } },
      ],
    })
  );
  const saved = await owner.query(`select direction from messages where organization_id = $1 and wa_message_id = 'wamid.un.echo.1'`, [ORG]);
  assert.equal(saved.rows[0]?.direction, "outbound");
});

test("a message naming nobody is set aside, not retried five times", db, async () => {
  await assert.doesNotReject(
    processor.processInboundWebhookJob(
      fromUsername({
        messages: [{ id: "wamid.un.in.3", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "?" } }],
      })
    )
  );
});
