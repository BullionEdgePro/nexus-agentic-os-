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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { withoutComments } from "../../../scripts/recurrence/source.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const source = (...p) => withoutComments(readFileSync(join(here, "..", "..", "..", ...p), "utf8"));

// ---------------------------------------------------------------------------
// The best-effort steps that took their whole transaction with them. Their
// setups are out of reach of a quick test database, so the shape is pinned.
// ---------------------------------------------------------------------------

test("an automation's failed action is that finding's alone; its claim stays", () => {
  const runner = source("apps", "api", "src", "services", "automation-runner.ts");
  assert.match(runner, /withSavepoint\(\(\) => perform\(automation, finding, organizationId\)\)/);
});

test("a bounce, an opt-out or a lead score that fails never loses the mailbox's mail", () => {
  const sync = source("apps", "api", "src", "services", "email-sync.ts");
  const store = sync.slice(sync.indexOf("async function storeInboxMail"));
  assert.match(store, /withSavepoint\(async \(\) => \{\s*const hit = await recordEmailBounce\(ownerAddress, address\);/);
  assert.match(store, /withSavepoint\(\(\) => optOutOfEmailCampaigns\(contactId\)\)/);
  assert.match(store, /withSavepoint\(\(\) =>\s*recordLeadAssessment\(/);
});

test("the assignment stands when the note of it fails", () => {
  const employees = source("apps", "api", "src", "routes", "employees.ts");
  assert.match(employees, /withSavepoint\(\(\) => recordAssignmentEvent\(conversationId, assigneeName, actor\.id, actor\.name\)\)/);
});

// The caught-error audit (3 Nov 2026): one save that makes two changes. The
// second refused (another phrase or procedure already on, a slot taken) used to
// undo the first silently while the 400 named only the second.
test("an edit stays saved when switching it on is refused", () => {
  const procedures = source("apps", "api", "src", "routes", "procedures.ts");
  assert.match(procedures, /withSavepoint\(\(\) => setProcedureActive\(organization\.id, id, body\.isActive, reviewer\)\)/);
  const phrases = source("apps", "api", "src", "routes", "phrases.ts");
  assert.match(phrases, /withSavepoint\(\(\) => setPhraseActive\(organization\.id, id, body\.isActive, reviewer\)\)/);
});

test("a status change stays saved when the reassignment after it is refused", () => {
  const bookings = source("apps", "api", "src", "routes", "bookings.ts");
  assert.match(bookings, /withSavepoint\(\(\) =>\s*assignBooking\(/);
  const tasks = source("apps", "api", "src", "routes", "tasks.ts");
  assert.match(tasks, /withSavepoint\(\(\) =>\s*assignTask\(/);
  assert.match(tasks, /withSavepoint\(\(\) => rescheduleTask\(taskId, dueAt, within\)\)/);
});

test("an automation's failure note cannot take its claims with it", () => {
  const runner = source("apps", "api", "src", "services", "automation-runner.ts");
  assert.match(runner, /withSavepoint\(\(\) => recordAutomationFailure\(runId, reason\)\)/);
});

// The reply job (caught-error audit, 3 Nov 2026): one transaction holds the
// customer's message, the reply and its records, and a dozen reads in it are
// "assume yes if this fails". Any of them failing on a database error took the
// customer's message out of the inbox while the reply still went to them.
test("every caught database call in the reply job is contained", () => {
  const job = source("apps", "api", "src", "queue", "processor.ts");
  const contained = [
    /isolated\(\(\) =>\s*withServingTenant\(organizationId, \(\) =>\s*getActivePhrase\(/,
    /isolated\(\(\) => getConversationRouting\(conversationId\)\)/,
    /isolated\(\(\) => recordConversationMetric\(input\)\)/,
    /isolated\(\(\) => wasAccountedFor\(conversationId, replayOf\.recordedAt\)\)/,
    /isolated\(\(\) => hasActiveEmployees\(answering\)\)/,
    /isolated\(\(\) => setConversationHandoff\(conversationId, false, "stale_release"\)\)/,
    /isolated\(\(\) => optOutOfReengagement\(contactId\)\)/,
    /isolated\(\(\) => findSharedNumberBusinesses\(ctx\.phoneNumberId\)\)/,
    /isolated\(\(\) => getConversationRouting\(ctx\.conversationId\)\)/,
    /isolated\(\(\) => findOrganizationById\(routedId\)\)/,
    /isolated\(\(\) =>\s*findRecentBroadcastSender\(/,
    /isolated\(\(\) => findOrganizationById\(business\.id\)\)/,
    /isolated\(\(\) => setConversationRouting\(ctx\.conversationId, organization\.id\)\)/,
    /isolated\(\(\) => recordTriagePrompt\(ctx\.conversationId\)\)/,
    /isolated\(\(\) => countPriorInbound\(input\.contactId\)\)/,
    /isolated\(\(\) =>\s*withServingTenant\(servingOrganizationId, \(\) =>\s*findEmployeeForConversation\(/,
  ];
  for (const shape of contained) assert.match(job, shape);
  // The four enrichments read for the serving business before the model runs.
  assert.equal((job.match(/isolated\(\(\) =>\s*withServingTenant\(serving\.id, /g) ?? []).length, 4);
  // The pipeline and the best-effort helpers whose catch keeps going: rolled
  // back only when the transaction broke, so a Redis blip keeps what was saved.
  assert.equal((job.match(/withRecovery\(async \(\) => \{/g) ?? []).length, 6);
});

test("the reply job's helpers outside it contain their caught calls too", () => {
  const availability = source("apps", "api", "src", "services", "availability.ts");
  const onShift = availability.slice(availability.indexOf("export async function hasStaffOnShift"));
  assert.match(onShift, /await isolated\(\(\) =>\s*withServingTenant\(organizationId, async \(\) => \{/);
  assert.match(onShift, /await isolated\(\(\) => busyEmployeeIds\(/);
  assert.match(availability, /isolated\(\(\) => withServingTenant\(servingOrganizationId, \(\) => stampAutoAssigned\(pick\.id\)\)\)/);
  const agents = (...p) => source("packages", "agents", "src", ...p);
  assert.match(agents("domain-agent.ts"), /output = await isolated\(\(\) => tool\.handler\(/);
  assert.match(agents("switchboard.ts"), /isolated\(\(\) => hasAnyoneOnARota\(organizationId\)\)/);
  assert.match(agents("procedure-recall.ts"), /await isolated\(\(\) => getSharedGuidance\(\)\)/);
});

// The request paths (caught-error audit, 3 Nov 2026): a caught read or best-effort
// write inside a request's one transaction left the rest of the request refused --
// a quick send's records lost, an assignment not saved, a page answering 500.
test("every caught database call on a request path is contained", () => {
  const src = (...p) => source("apps", "api", "src", ...p);
  const expect = {
    "lib/actor.ts": [/isolated\(\(\) => findEmployeeById\(employeeId\)\)\.catch/, /isolated\(\(\) => findAdminById\(adminId\)\)\.catch/],
    "routes/employees.ts": [/isolated\(\(\) => getConversationRouting\(conversationId\)\)/],
    "routes/my-campaigns.ts": [/isolated\(\(\) => dailyReachUsed\(/],
    "routes/team-chat.ts": [/isolated\(\(\) => getConversationRouting\(shareId\)\)\.catch/],
    "routes/tasks.ts": [/isolated\(\(\) => getConversationRouting\(conversationId\)\)\.catch/],
    "routes/connections.ts": [
      /isolated\(\(\) =>\s*withTenant\(owner\.organizationId, \(\) =>\s*recordSync\(owner\.organizationId, owner\.employeeId, "tiktok", null\)/,
      /withRecovery\(\(\) => runEmailSync\(owner, token\.accessToken\)\)/,
    ],
    "services/email-sync.ts": [/isolated\(\(\) =>\s*withTenant\(owner\.organizationId, \(\) =>\s*refreshStoredAccessToken\(/],
    "services/quality-rollup.ts": [
      /isolated\(\(\) => withTenant\(organization\.id, \(\) => rollUpQualityDay\(organization\.id, day\)\)\)/,
      /isolated\(\(\) => withTenant\(organization\.id, \(\) => rollUpProcedureOutcomes\(organization\.id\)\)\)/,
      /isolated\(\(\) => rollUpSharedPatterns\(\)\)/,
    ],
    "routes/operators.ts": [/const heartbeats = await isolated\(\(\) => listJobHeartbeats\(\)\)\.catch\(\(\) => \[\]\)/, /isolated\(\(\) => conversationViewers\(subjectId\)\)/],
    "routes/hq.ts": [/isolated\(\(\) =>\s*withTenant\(business\.id, \(\) => listConnections\(business\.id, null\)\)/],
    "routes/admin-bulk.ts": [/const usedToday = await isolated\(\(\) => dailyReachUsed\(number\.phoneNumberId\)\)\.catch\(\(\) => null\)/],
  };
  for (const [file, shapes] of Object.entries(expect)) {
    const text = src(...file.split("/"));
    for (const shape of shapes) assert.match(text, shape, `${file}: ${shape}`);
  }
  const connections = src("routes", "connections.ts");
  assert.equal(
    (connections.match(/isolated\(\(\) =>\s*withTenant\(owner\.organizationId, \(\) =>\s*recordSync\(owner\.organizationId, owner\.employeeId, "gmail", null\)/g) ?? []).length,
    2,
    "both Gmail success marks are contained"
  );
  const conversations = src("routes", "conversations.ts");
  assert.equal((conversations.match(/isolated\(\(\) => getConversationRouting\(conversationId\)\)\.catch\(\(\) => null\)/g) ?? []).length, 2);
  // Side by side on one connection a savepoint cannot contain a failed read:
  // the timeline's reads, and the messages beside them, run one after another.
  const timeline = conversations.slice(conversations.indexOf("async function buildTimeline"), conversations.indexOf("conversationsRoute.get(\"/:id/messages\""));
  assert.doesNotMatch(timeline, /Promise\.all/);
  for (const read of ["listConversationEvents", "listCustody", "listCallLogs", "resolveActorNames"]) {
    assert.match(timeline, new RegExp(`isolated\\(\\(\\) => ${read}\\(`), read);
  }
  assert.match(conversations, /const messages = await getMessagesForConversation\(conversationId\);\s*const timeline = await buildTimeline\(conversationId\);/);
  const hq = src("routes", "hq.ts");
  assert.doesNotMatch(hq.slice(hq.indexOf("await Promise.all(["), hq.indexOf("]);", hq.indexOf("await Promise.all(["))), /listConnections/);
  const handover = source("packages", "agents", "src", "handover.ts");
  assert.match(handover, /isolated\(\(\) => listOpenTasksForConversation\(conversationId\)\)/);
  assert.match(handover, /isolated\(\(\) => loadRecentHistory\(conversationId, 30\)\)/);
  const organizations = source("packages", "db", "src", "organizations.ts");
  assert.match(organizations, /isolated\(\(\) =>\s*getPool\(\)\.query<\{ id: string; whatsapp_display_number/);
});

test("one business's failed read leaves the others on the not-reported list", () => {
  const operators = source("apps", "api", "src", "services", "operators.ts");
  assert.match(operators, /isolated\(\(\) =>\s*withTenant\(organization\.id, \(\) => unansweredButNotReportedFor\(organization\.id\)\)/);
});

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
  // Like editing a phrase and switching it on while another is on: the edit is
  // written, the switch-on is refused, and the handler says what to do.
  app.post("/api/organizations/:slug/declines/:waId", async (c) => {
    await insertContact(c.req.param("waId"));
    await swallow();
    return c.json({ error: "Another phrase for this moment is already switched on." }, 400);
  });
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(DROP_REFUSAL);
    await owner.query(`delete from bookings where organization_id = $1`, [ORG]);
    await owner.query(`delete from broadcast_recipients where broadcast_id in (select id from broadcasts where organization_id = $1)`, [ORG]);
    await owner.query(`delete from broadcasts where organization_id = $1`, [ORG]);
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

test("a handler that already answered with an error keeps its own words", db, async () => {
  // Final review (3 Nov 2026): the 500 is for a request that would otherwise
  // claim success. One that already said it failed, and why, keeps saying so.
  const response = await app.request("/api/organizations/srb-org/declines/971595000009", { method: "POST" });
  assert.equal(response.status, 400, "a deliberate refusal became a generic 500");
  assert.deepEqual(await response.json(), { error: "Another phrase for this moment is already switched on." });
  assert.equal(await contactNamed("971595000009"), 0);
});

test("a write made inside a with-query counts as a write", db, async () => {
  // `with i as (insert … returning …) select … from i` settles as SELECT; 16
  // functions write this way, createBooking and createTask among them.
  const err = await outcomeOf(
    lib.withTenant(ORG, async () => {
      await lib
        .getPool()
        .query(
          `with i as (insert into contacts (organization_id, wa_id, channel, display_name) values ($1, '971595000010', 'whatsapp', 'Probe') returning id) select id from i`,
          [ORG]
        );
      await swallow();
    }, failing)
  );
  assert.notEqual(err, null, "a lost write made in a with-query was reported as a success");
  assert.equal(err.name, "TransactionRolledBack");
});

test("auto-assign's failure stays its own, on the live reply path", () => {
  // It never throws, and it runs inside the message's transaction: a database
  // error in it let the reply go out while the message and the reply were lost.
  const availability = source("apps", "api", "src", "services", "availability.ts");
  const fn = availability.slice(availability.indexOf("export async function autoAssignIfEnabled"));
  assert.match(fn, /try \{\s*return await isolated\(async \(\) => \{/);
});

test("a failed send-token lookup cannot abort the send's transaction", () => {
  // It falls back to the shared token on any error, so a database error there
  // left every later record of a quick send refused -- and the 500 that now
  // follows would invite a retry that messages everyone twice.
  const client = source("apps", "api", "src", "lib", "whatsapp-client.ts");
  assert.match(client, /await isolated\(\(\) => whatsappSendTokenForNumber\(phoneNumberId\)\)/);
});

test("a campaign message that went out is never sent again when its 'sent' mark fails", db, async () => {
  // The mark sat inside the send's try: failing, it was treated as a failed
  // send, the 'failed' mark was refused too, the job threw, and the queue's
  // retry sent the template to the customer again (caught-error audit).
  const { processBroadcastSendJob } = await import("../src/queue/broadcast-processor.ts");
  const broadcast = (
    await owner.query(
      `insert into broadcasts (organization_id, channel, from_mailbox, email_subject, email_body, status)
       values ($1, 'email', 'probe@firm.test', 'Probe', 'Probe body', 'sending') returning id`,
      [ORG]
    )
  ).rows[0].id;
  const recipient = (
    await owner.query(`insert into broadcast_recipients (broadcast_id, contact_id, status) values ($1, $2, 'pending') returning id`, [
      broadcast,
      CONTACT1,
    ])
  ).rows[0].id;
  await owner.query(`
    create or replace function srb_refuse_sent() returns trigger language plpgsql as $$
    begin raise exception 'refused for the test'; end $$;
    drop trigger if exists srb_refuse_sent on broadcast_recipients;
    create trigger srb_refuse_sent before update on broadcast_recipients
      for each row when (new.status = 'sent') execute function srb_refuse_sent();`);
  const sends = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.META_ACCESS_TOKEN;
  process.env.META_ACCESS_TOKEN = "probe-token-never-sent"; // fetch is replaced below
  globalThis.fetch = async (url) => {
    sends.push(String(url));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.srb-campaign" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const logged = mock.method(console, "error", () => undefined);
  let outcome;
  try {
    const job = {
      data: {
        broadcastId: broadcast,
        recipientId: recipient,
        contactWaId: "971595000101",
        phoneNumberId: "950001",
        templateName: "probe",
        templateLanguage: "en",
        templateParams: [],
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
    };
    outcome = await processBroadcastSendJob(job).then(() => "finished", (err) => err.message);
  } finally {
    logged.mock.restore();
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = realToken;
    await owner.query(`drop trigger if exists srb_refuse_sent on broadcast_recipients; drop function if exists srb_refuse_sent();`);
  }
  assert.equal(sends.length, 1);
  assert.equal(outcome, "finished", "the job failed after the send, so the queue would send it again");
});

test("withRecovery keeps the work when the transaction survived the failure", db, async () => {
  // A Redis blip after a reply was recorded must not erase the record.
  await lib.withTenant(ORG, async () => {
    await lib
      .withRecovery(async () => {
        await insertContact("971595000030");
        throw new Error("not the database");
      })
      .catch(() => undefined);
  }, failing);
  assert.equal(await contactNamed("971595000030"), 1);
});

test("withRecovery undoes the work when the transaction broke, so the catch can still write", db, async () => {
  await lib.withTenant(ORG, async () => {
    await lib
      .withRecovery(async () => {
        await insertContact("971595000031");
        await lib.getPool().query("select 1/0");
      })
      .catch(() => undefined);
    await insertContact("971595000032"); // the catch's fallback record
  }, failing);
  assert.equal(await contactNamed("971595000031"), 0);
  assert.equal(await contactNamed("971595000032"), 1, "the transaction was still broken after the failure");
});

test("a handler that swallowed a failure after writing answers 500", db, async () => {
  const response = await app.request("/api/organizations/srb-org/swallows/971595000008", { method: "POST" });
  assert.equal(response.status, 500, "the request answered success with its write lost");
  assert.equal(await contactNamed("971595000008"), 0);
});
