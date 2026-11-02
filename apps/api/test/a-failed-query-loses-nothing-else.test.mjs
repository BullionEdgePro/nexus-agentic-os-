// A failed query never silently loses a request's records (3 Nov 2026).
//
// Once a statement fails inside a Postgres transaction, every later statement
// is refused ("current transaction is aborted", 25P02) and the commit comes back
// as ROLLBACK -- not as an error. Code that caught the first error and carried
// on therefore lost everything it had written, and the request still answered
// 200: a quick send reported "sent" with nothing recorded, a scheduled message
// went out again every minute.
//
// Now a request that lost a write answers 500 with the caught failure as its
// cause, a job that lost one says so in the log (a retry would repeat what it
// did outside the database), a read-only transaction keeps the answer its code
// chose, and the places that carry on past one failed item isolate it.
// Takes its turn at the shared test database.
// Spec: docs/superpowers/specs/2026-11-03-silent-rollback-design.md
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "92929292-0000-4000-8000-000000000001";
const CONTACT1 = "92929292-0000-4000-8000-0000000000a1";
const CONTACT2 = "92929292-0000-4000-8000-0000000000a2";
const CONTACT3 = "92929292-0000-4000-8000-0000000000a3";
const CONV1 = "92929292-0000-4000-8000-0000000000c1";
const CONV2 = "92929292-0000-4000-8000-0000000000c2"; // a message recorded here is refused
const CONV3 = "92929292-0000-4000-8000-0000000000c3";
const STAFF = "e9292920-0000-4000-8000-000000000001";
const people = [
  { id: CONTACT1, displayName: "Probe One", waId: "971595000101", conversationId: CONV1 },
  { id: CONTACT2, displayName: "Probe Two", waId: "971595000102", conversationId: CONV2 },
  { id: CONTACT3, displayName: "Probe Three", waId: "971595000103", conversationId: CONV3 },
];

let owner;
let dbTurn; // this file's turn at the shared test database
let app;
let lib;

const contactNamed = async (waId) =>
  (await owner.query(`select 1 from contacts where organization_id = $1 and wa_id = $2`, [ORG, waId])).rowCount;
const insertContact = (waId) =>
  lib.getPool().query(`insert into contacts (organization_id, wa_id, channel, display_name) values ($1, $2, 'whatsapp', 'Probe')`, [
    ORG,
    waId,
  ]);
// A failure the code catches and carries on past.
const swallow = () => lib.getPool().query("select 1/0").catch(() => undefined);
const messagesIn = async (conversationId) =>
  Number((await owner.query(`select count(*) from messages where conversation_id = $1`, [conversationId])).rows[0].count);
const DROP_REFUSAL = `drop trigger if exists srb_refuse_messages on messages; drop function if exists srb_refuse_messages();`;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_number_owner)
     values ($1, 'srb-org', 'Probe Firm', '950001', '850001', 'Asia/Dubai', true)`,
    [ORG]
  );
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'SRB1', 'Probe Staff')`, [STAFF, ORG]);
  for (const person of people) {
    await owner.query(`insert into contacts (id, organization_id, wa_id, channel, display_name) values ($1, $2, $3, 'whatsapp', $4)`, [
      person.id,
      ORG,
      person.waId,
      person.displayName,
    ]);
    await owner.query(`insert into conversations (id, organization_id, contact_id, channel) values ($1, $2, $3, 'whatsapp')`, [
      person.conversationId,
      ORG,
      person.id,
    ]);
  }
  // The injected failure: recording a message in the second conversation is refused.
  await owner.query(DROP_REFUSAL);
  await owner.query(`
    create function srb_refuse_messages() returns trigger language plpgsql as $$
    begin
      if new.conversation_id = '${CONV2}' then raise exception 'refused for the test'; end if;
      return new;
    end $$;
    create trigger srb_refuse_messages before insert on messages for each row execute function srb_refuse_messages();`);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  const { Hono } = await import("hono");
  const { tenantContext, webhookContext } = await import("../src/middleware/tenant-context.ts");
  // Mounted exactly as index.ts mounts them.
  app = new Hono();
  app.use("/api/organizations/:slug/*", tenantContext);
  app.use("/api/*", tenantContext);
  app.use("/webhooks/*", webhookContext);
  app.post("/api/organizations/:slug/swallows/:waId", async (c) => {
    await insertContact(c.req.param("waId"));
    await swallow();
    return c.json({ ok: true });
  });
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(DROP_REFUSAL);
    await owner.query(`delete from bookings where organization_id = $1`, [ORG]);
    await owner.query(`delete from messages where organization_id = $1 or serving_organization_id = $1`, [ORG]);
    await owner.query(`delete from lead_assessments where organization_id = $1 or serving_organization_id = $1`, [ORG]);
    await owner.query(`delete from conversations where organization_id = $1 or routed_organization_id = $1`, [ORG]);
    await owner.query(`delete from organizations where id = $1`, [ORG]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    if (lib) await lib.getPool().end();
  }
});

const outcomeOf = (promise) => promise.then(() => null, (err) => err);
const failing = { failOnLostWrites: true };

test("a request's lost write is refused, and says why", db, async () => {
  const err = await outcomeOf(
    lib.withTenant(ORG, async () => {
      await insertContact("971595000001");
      await swallow();
    }, failing)
  );
  assert.notEqual(err, null, "a transaction that lost its write was reported as a success");
  assert.equal(err.name, "TransactionRolledBack");
  assert.match(err.message, /^Nothing in this piece of work was saved/);
  assert.match(String(err.cause?.message), /division by zero/, "the cause is the failure that was caught");
  assert.equal(await contactNamed("971595000001"), 0);
});

test("a write refused after a caught failure is a lost write too", db, async () => {
  const err = await outcomeOf(
    lib.withTenant(ORG, async () => {
      await swallow();
      await insertContact("971595000002").catch(() => undefined);
    }, failing)
  );
  assert.notEqual(err, null, "a write Postgres refused was reported as a success");
  assert.equal(err.name, "TransactionRolledBack");
});

test("without the option the lost write is logged as an error, and nothing throws", db, async () => {
  const logged = mock.method(console, "error", () => undefined);
  try {
    const err = await outcomeOf(
      lib.withTenant(ORG, async () => {
        await insertContact("971595000003");
        await swallow();
      })
    );
    assert.equal(err, null, "a job that lost a write must not start failing");
    const lines = logged.mock.calls.map((call) => call.arguments.map(String).join(" "));
    assert.ok(
      lines.some((line) => /\[db\].*Nothing in this piece of work was saved/.test(line)),
      "the lost write was not logged"
    );
  } finally {
    logged.mock.restore();
  }
  assert.equal(await contactNamed("971595000003"), 0);
});

test("a read-only transaction keeps the answer its code chose, and warns", db, async () => {
  const warned = mock.method(console, "warn", () => undefined);
  try {
    const answer = await lib.withTenant(ORG, async () => {
      await swallow();
      return "the default its code chose";
    }, failing);
    assert.equal(answer, "the default its code chose");
    assert.ok(
      warned.mock.calls.some((call) => /\[db\]/.test(call.arguments.map(String).join(" "))),
      "the caught failure left no trace"
    );
  } finally {
    warned.mock.restore();
  }
});

test("a failure undone by a savepoint is not a lost write", db, async () => {
  await lib.withTenant(ORG, async () => {
    await lib.withSavepoint(() => lib.getPool().query("select 1/0")).catch(() => undefined);
    await insertContact("971595000004");
  }, failing);
  assert.equal(await contactNamed("971595000004"), 1);
});

test("a write undone on purpose by a savepoint is not lost either", db, async () => {
  const warned = mock.method(console, "warn", () => undefined);
  try {
    await lib.withTenant(ORG, async () => {
      await lib
        .withSavepoint(async () => {
          await insertContact("971595000005");
          throw new Error("changed my mind");
        })
        .catch(() => undefined);
      await swallow();
    }, failing);
  } finally {
    warned.mock.restore();
  }
  assert.equal(await contactNamed("971595000005"), 0);
});

test("a locking read refused after a failure is not a write", db, async () => {
  const warned = mock.method(console, "warn", () => undefined);
  try {
    await lib.withTenant(ORG, async () => {
      await swallow();
      await lib.getPool().query(`select id from organizations where id = $1 for update`, [ORG]).catch(() => undefined);
    }, failing);
  } finally {
    warned.mock.restore();
  }
});

test("only the outermost context decides", db, async () => {
  const logged = mock.method(console, "error", () => undefined);
  try {
    const err = await outcomeOf(
      lib.withAllTenants("probe: an outer context without the option", () =>
        lib.withTenant(ORG, async () => {
          await insertContact("971595000006");
          await swallow();
        }, failing)
      )
    );
    assert.equal(err, null, "an inner call's option overrode the context it runs in");
  } finally {
    logged.mock.restore();
  }
});

test("isolated() runs as it is outside a transaction, and in a savepoint inside one", db, async () => {
  assert.equal(await lib.isolated(async () => "ran"), "ran");
  await lib.withTenant(ORG, async () => {
    await assert.rejects(lib.isolated(() => lib.getPool().query("select 1/0")), /division by zero/);
    await insertContact("971595000007");
  }, failing);
  assert.equal(await contactNamed("971595000007"), 1, "the failure inside isolated() aborted its caller");
});

test("one person's record failing in a quick send loses that record only", db, async () => {
  const { sendQuickMessages } = await import("../src/lib/quick-send.ts");
  const outcome = await lib.withTenant(
    ORG,
    () =>
      sendQuickMessages({
        people,
        text: "Probe hello {name}",
        phoneNumberId: "950001",
        send: async () => ({ waMessageId: null }),
        record: (person, message) =>
          lib
            .insertOutboundMessage({
              organizationId: ORG,
              conversationId: person.conversationId,
              contactId: person.id,
              senderType: "human_agent",
              body: message,
            })
            .then(() => undefined),
      }),
    failing
  );
  assert.deepEqual(outcome, { sent: 3, failed: [], notRecorded: ["Probe Two"] });
  assert.equal(await messagesIn(CONV1), 1, "the first person's record was lost with the second's");
  assert.equal(await messagesIn(CONV2), 0);
  assert.equal(await messagesIn(CONV3), 1, "the third person's record was lost with the second's");
});

test("a scheduled message whose record failed is marked sent and never sent again", db, async () => {
  // The inbox announcement goes to Redis, which a test database run has none of.
  mock.module(new URL("../src/lib/pubsub.ts", import.meta.url).href, {
    namedExports: {
      INBOX_EVENTS_CHANNEL: "nexus:inbox-events",
      publishInboxEvent: async () => undefined,
      subscribeToInboxEvents: () => () => undefined,
    },
  });
  const { processScheduledMessageSweep } = await import("../src/queue/scheduled-messages-processor.ts");
  for (const [i, person] of people.entries()) {
    await owner.query(
      `insert into scheduled_messages (organization_id, conversation_id, contact_id, body, send_at, created_by)
       values ($1, $2, $3, $4, now() - interval '1 minute', 'owner')`,
      [ORG, person.conversationId, person.id, `Scheduled ${i + 1}`]
    );
  }
  const statuses = async () =>
    (await owner.query(`select status from scheduled_messages where organization_id = $1 order by body`, [ORG])).rows.map(
      (row) => row.status
    );
  const before1 = await messagesIn(CONV1);
  const before3 = await messagesIn(CONV3);
  const sends = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.META_ACCESS_TOKEN;
  process.env.META_ACCESS_TOKEN = "probe-token-never-sent"; // fetch is replaced below
  globalThis.fetch = async (url) => {
    sends.push(String(url));
    return new Response(JSON.stringify({ messages: [{ id: `wamid.srb-${sends.length}` }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const logged = mock.method(console, "error", () => undefined);
  try {
    const first = await processScheduledMessageSweep({}).then(() => "finished", (err) => err.message);
    assert.equal(first, "finished", "one failed record took the whole sweep down");
    assert.deepEqual(await statuses(), ["sent", "sent", "sent"], "a message that went out is not marked sent");
    assert.equal(await messagesIn(CONV1), before1 + 1);
    assert.equal(await messagesIn(CONV3), before3 + 1);
    await processScheduledMessageSweep({});
    assert.equal(sends.length, 3, "a customer was messaged again");
  } finally {
    logged.mock.restore();
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = realToken;
  }
});

test("a slot taken by someone else leaves the rest of the transaction working", db, async () => {
  // Two customers asking for the same time is a normal race. The second booking
  // is refused -- and that refusal used to abort the transaction the AI reply
  // runs in, so the reply went out and every record of the message was lost.
  const slot = {
    organizationId: ORG,
    contactId: CONTACT1,
    employeeId: STAFF,
    startsAt: "2030-01-07T09:00:00Z",
    endsAt: "2030-01-07T09:30:00Z",
  };
  await lib.withTenant(
    ORG,
    async () => {
      await lib.createBooking(slot);
      await assert.rejects(lib.createBooking(slot), lib.SlotTakenError);
      await insertContact("971595000020");
    },
    failing
  );
  assert.equal(await contactNamed("971595000020"), 1);
});

test("a handler that swallowed a failure after writing answers 500", db, async () => {
  const response = await app.request("/api/organizations/srb-org/swallows/971595000008", { method: "POST" });
  assert.equal(response.status, 500, "the request answered success with its write lost");
  assert.equal(await contactNamed("971595000008"), 0);
});
