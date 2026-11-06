// One customer, one contact, username or not (6 Nov 2026, migration 109).
//
// Meta sends a customer's business-scoped user id (BSUID) on every message and
// their number only when it may. Since this morning a customer known only by
// BSUID is kept under it -- which made the same person two contacts the moment
// they switched a username on (number first, BSUID after), or showed their
// number after starting under a username (BSUID first, number after). And a
// connected phone's past chats with such a customer were skipped on import.
//
// Now each BSUID Meta sends together with a number is kept (whatsapp_user_ids),
// a message with the BSUID alone is filed under that number, a contact first
// filed under a BSUID moves to the number when it arrives, and the history
// import files a thread by number, else by BSUID.
//
// Runs the real inbound job against the throwaway Postgres; Redis and Meta are
// stood in.
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "97979797-0000-4000-8000-000000000001";
const SEAT = "97979797-0000-4000-8000-0000000000e1";
const SEAT_NUMBER = "970001";

let owner;
let dbTurn;
let processor;

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
// The history import keeps names and its progress in Redis.
const kv = new Map();
mock.module(new URL("../src/queue/queue.ts", import.meta.url).href, {
  namedExports: {
    getRedisConnection: () => ({
      status: "ready",
      once() {},
      off() {},
      get: async (k) => kv.get(k) ?? null,
      set: async (k, v) => void kv.set(k, v),
      hget: async (k, f) => kv.get(`${k}#${f}`) ?? null,
      hset: async (k, f, v) => void kv.set(`${k}#${f}`, v),
      expire: async () => 1,
      sadd: async () => 1,
      hsetnx: async () => 1,
      hincrby: async () => 1,
    }),
  },
});

const realFetch = globalThis.fetch;
process.env.META_ACCESS_TOKEN = "probe-token-never-sent";
globalThis.fetch = async (url) =>
  String(url).includes("graph.facebook.com")
    ? new Response(JSON.stringify({ messages: [{ id: "wamid.oc.out" }] }), { status: 200, headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 503 });

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'oc-org', 'One Contact', '970009', '870009', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, whatsapp_phone_number_id, is_active)
     values ($1, $2, 'OC1', 'Probe Seat', $3, true)`,
    [SEAT, ORG, SEAT_NUMBER]
  );
  process.env.DATABASE_URL = APP_URL;
  processor = await import("../src/queue/processor.ts");
});

after(async () => {
  globalThis.fetch = realFetch;
  if (db.skip) return;
  try {
    await owner.query(`delete from whatsapp_user_ids where user_id like 'AE.97%'`).catch(() => undefined);
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

const now = () => String(Math.floor(Date.now() / 1000));
const delivery = (value, field = "messages") => ({
  data: {
    phoneNumberId: SEAT_NUMBER,
    payload: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "870009",
          changes: [
            { field, value: { messaging_product: "whatsapp", metadata: { display_phone_number: "971500000000", phone_number_id: SEAT_NUMBER }, ...value } },
          ],
        },
      ],
    },
  },
});
const message = (id, { from, userId, name, username }) =>
  delivery({
    contacts: [{ ...(from ? { wa_id: from } : {}), user_id: userId, profile: { ...(name ? { name } : {}), ...(username ? { username } : {}) } }],
    messages: [{ ...(from ? { from } : {}), from_user_id: userId, id, timestamp: now(), type: "text", text: { body: `message ${id}` } }],
  });
const contactsOf = async () =>
  (await owner.query(`select wa_id from contacts where organization_id = $1 order by wa_id`, [ORG])).rows.map((r) => r.wa_id);
const conversationOf = async (wamid) =>
  (await owner.query(`select conversation_id from messages where organization_id = $1 and wa_message_id = $2`, [ORG, wamid])).rows[0]
    ?.conversation_id;

test("number first, then a username: one contact, one chat", db, async () => {
  const BSUID = "AE.9701";
  await processor.processInboundWebhookJob(message("wamid.oc.1", { from: "971500970001", userId: BSUID, name: "Omar" }));
  await processor.processInboundWebhookJob(message("wamid.oc.2", { userId: BSUID, username: "@omar.buys" }));
  assert.deepEqual(await contactsOf(), ["971500970001"], "a username-only message made a second contact");
  assert.equal(await conversationOf("wamid.oc.2"), await conversationOf("wamid.oc.1"));
});

test("a username first, then the number: the contact moves to the number", db, async () => {
  const BSUID = "AE.9702";
  await processor.processInboundWebhookJob(message("wamid.oc.3", { userId: BSUID, username: "@sara.homes" }));
  assert.ok((await contactsOf()).includes(BSUID));
  await processor.processInboundWebhookJob(message("wamid.oc.4", { from: "971500970002", userId: BSUID, name: "Sara" }));
  const contacts = await contactsOf();
  assert.ok(contacts.includes("971500970002"));
  assert.ok(!contacts.includes(BSUID), "the username contact stayed beside the number one");
  assert.equal(await conversationOf("wamid.oc.4"), await conversationOf("wamid.oc.3"), "the chat did not continue");
  const pair = await owner.query(`select wa_id from whatsapp_user_ids where user_id = $1`, [BSUID]);
  assert.equal(pair.rows[0]?.wa_id, "971500970002");
});

test("what the person sends from their phone to a username finds the number contact", db, async () => {
  await processor.processInboundWebhookJob(
    delivery(
      { message_echoes: [{ from: "971500000000", to_user_id: "AE.9701", id: "wamid.oc.echo", timestamp: now(), type: "text", text: { body: "Thanks Omar" } }] },
      "smb_message_echoes"
    )
  );
  assert.equal(await conversationOf("wamid.oc.echo"), await conversationOf("wamid.oc.1"));
});

test("a connected phone's past chat with a username customer is imported, the right way round", db, async () => {
  const BSUID = "AE.9703";
  await processor.processInboundWebhookJob(
    delivery(
      {
        history: [
          {
            metadata: { phase: 0, chunk_order: 1, progress: 100 },
            threads: [
              {
                context: { user_id: BSUID, username: "@quiet.lead" },
                messages: [
                  { from_user_id: BSUID, id: "wamid.oc.h1", timestamp: now(), type: "text", text: { body: "Hi, is it available?" } },
                  { from: "971500000000", to_user_id: BSUID, id: "wamid.oc.h2", timestamp: now(), type: "text", text: { body: "Yes" } },
                ],
              },
            ],
          },
        ],
      },
      "history"
    )
  );
  const rows = (
    await owner.query(`select wa_message_id, direction from messages where organization_id = $1 and wa_message_id like 'wamid.oc.h%' order by wa_message_id`, [ORG])
  ).rows;
  assert.deepEqual(rows, [
    { wa_message_id: "wamid.oc.h1", direction: "inbound" },
    { wa_message_id: "wamid.oc.h2", direction: "outbound" },
  ]);
  assert.ok((await contactsOf()).includes(BSUID));
});

test("a number Meta's way never fails the message: a malformed pair is skipped", db, async () => {
  await assert.doesNotReject(processor.processInboundWebhookJob(message("wamid.oc.5", { from: "971500970005", userId: "not-a-bsuid" })));
  assert.ok((await contactsOf()).includes("971500970005"));
});
