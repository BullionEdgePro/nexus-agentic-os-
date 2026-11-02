// A request's transaction ends the way the request did (3 Nov 2026).
//
// Every API request runs inside one transaction (tenantContext; webhooks in
// webhookContext). Two things ended it wrongly:
//
//   - setSystemPrompt and replaceBusy ran their own begin/commit through
//     getPool(), which inside a context is the request's own connection: the
//     commit ended the request's transaction early and dropped its tenant
//     settings, so the prompt saved and then "could not be read back".
//   - Hono answers a handler's thrown error with a 500 itself and never rethrows
//     it into the middleware, so the transaction committed whatever the handler
//     wrote before it threw.
//
// Now a piece of work is atomic inside the open transaction (withSavepoint), a
// request whose handler threw rolls back, and an answer the handler chose —
// any status — commits as before. Takes its turn at the shared test database.
// Spec: docs/superpowers/specs/2026-11-03-request-transactions-design.md
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("nothing in the data layer opens or commits a transaction of its own", () => {
  for (const file of ["agent-config.ts", "calendars.ts"]) {
    const src = read("packages", "db", "src", file);
    assert.doesNotMatch(src, /query\(\s*["'`](begin|commit|rollback)["'`]/i, `${file} ends the caller's transaction`);
    assert.match(src, /withSavepoint\(/, `${file} keeps its work atomic inside the open transaction`);
  }
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "91919191-0000-4000-8000-000000000001";
const STAFF = "e9191910-0000-4000-8000-000000000001";

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

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_number_owner)
     values ($1, 'rtx-org', 'Probe Firm', '940001', '840001', 'Asia/Dubai', true)`,
    [ORG]
  );
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'RTX1', 'Probe Staff')`, [STAFF, ORG]);
  await owner.query(
    `insert into employee_calendars (organization_id, employee_id, ics_url, created_by) values ($1, $2, 'https://calendar.test/probe.ics', 'owner')`,
    [ORG, STAFF]
  );
  await owner.query(
    `insert into agent_configs (organization_id, name, system_prompt, is_active)
     values ($1, 'Probe agent', 'You answer customers of a probe firm politely and briefly, in their own language.', true)`,
    [ORG]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  const { Hono } = await import("hono");
  const { tenantContext, webhookContext } = await import("../src/middleware/tenant-context.ts");
  // Mounted exactly as index.ts mounts them.
  app = new Hono();
  app.use("/api/organizations/:slug/*", tenantContext);
  app.use("/api/*", tenantContext);
  app.use("/webhooks/*", webhookContext);
  app.post("/api/organizations/:slug/throws/:waId", async (c) => {
    await insertContact(c.req.param("waId"));
    throw new Error("the handler failed half-way");
  });
  app.post("/api/organizations/:slug/answers-500/:waId", async (c) => {
    await insertContact(c.req.param("waId"));
    return c.json({ error: "recorded, and said so" }, 500);
  });
  app.post("/api/organizations/:slug/answers-200/:waId", async (c) => {
    await insertContact(c.req.param("waId"));
    return c.json({ ok: true });
  });
  app.post("/api/elsewhere/throws/:waId", async (c) => {
    await insertContact(c.req.param("waId"));
    throw new Error("a cross-tenant handler failed half-way");
  });
  app.post("/webhooks/probe/throws/:waId", async (c) => {
    await insertContact(c.req.param("waId"));
    throw new Error("a webhook failed half-way");
  });
});

after(async () => {
  if (db.skip) return;
  try {
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

const post = async (path) => (await app.request(path, { method: "POST" })).status;

test("a request whose handler threw leaves nothing behind, and still answers 500", db, async () => {
  assert.equal(await post("/api/organizations/rtx-org/throws/971594000001"), 500);
  assert.equal(await contactNamed("971594000001"), 0, "the business request's write was rolled back");
  assert.equal(await post("/api/elsewhere/throws/971594000002"), 500);
  assert.equal(await contactNamed("971594000002"), 0, "a cross-tenant request's write was rolled back");
  assert.equal(await post("/webhooks/probe/throws/971594000003"), 500);
  assert.equal(await contactNamed("971594000003"), 0, "a webhook's write was rolled back");
});

test("a request whose handler answered keeps its work, whatever the status", db, async () => {
  assert.equal(await post("/api/organizations/rtx-org/answers-500/971594000004"), 500);
  assert.equal(await contactNamed("971594000004"), 1, "a deliberate error answer keeps what it recorded");
  assert.equal(await post("/api/organizations/rtx-org/answers-200/971594000005"), 200);
  assert.equal(await contactNamed("971594000005"), 1);
});

test("saving the agent's prompt answers with the new prompt and keeps the old one", db, async () => {
  const prompt = "You answer customers of the probe firm in their own language, briefly, and hand over to a person for prices.";
  const { result, orgAfter } = await lib.withTenant(ORG, async () => {
    const result = await lib.setSystemPrompt({ organizationId: ORG, systemPrompt: prompt, changedBy: "owner", note: "test" });
    const orgAfter = (await lib.getPool().query(`select current_setting('app.current_org', true) as org`)).rows[0].org;
    return { result, orgAfter };
  });
  assert.equal(result.reason, undefined, result.reason);
  assert.equal(result.config.systemPrompt, prompt);
  assert.equal(orgAfter, ORG, "the request is still scoped to its business afterwards");
  const versions = await owner.query(`select 1 from agent_config_versions where organization_id = $1`, [ORG]);
  assert.equal(versions.rowCount, 1);
});

test("replacing a person's busy time keeps the transaction it runs in", db, async () => {
  const orgAfter = await lib.withTenant(ORG, async () => {
    await lib.replaceBusy(ORG, STAFF, [{ uid: "probe-1", startsAt: new Date(Date.now() + 3600e3), endsAt: new Date(Date.now() + 7200e3) }], 0);
    return (await lib.getPool().query(`select current_setting('app.current_org', true) as org`)).rows[0].org;
  });
  assert.equal(orgAfter, ORG);
  assert.equal((await owner.query(`select 1 from calendar_busy where employee_id = $1`, [STAFF])).rowCount, 1);
});

test("withSavepoint undoes only its own work and leaves the transaction usable", db, async () => {
  await lib.withTenant(ORG, async () => {
    await assert.rejects(
      lib.withSavepoint(async () => {
        await insertContact("971594000006");
        throw new Error("half-way");
      }),
      /half-way/
    );
    // Nested savepoints each get their own name.
    await lib.withSavepoint(() => lib.withSavepoint(() => insertContact("971594000007")));
  });
  assert.equal(await contactNamed("971594000006"), 0, "the failed piece was undone");
  assert.equal(await contactNamed("971594000007"), 1, "the transaction carried on and committed");
  await assert.rejects(lib.withSavepoint(async () => 1), /context/, "without an open transaction it refuses");
});

test("a campaign job whose campaign is not in the database sends nothing and is tried again", db, async () => {
  // A send request that threw half-way through queueing now rolls its campaign
  // back, but the jobs already in Redis still run. The worker can also take a
  // job before the request that queued it has committed. Either way there is no
  // campaign to check yet, so the job must not send: thrown, the queue retries.
  const { processBroadcastSendJob } = await import("../src/queue/broadcast-processor.ts");
  const sends = [];
  const realFetch = globalThis.fetch;
  const realToken = process.env.META_ACCESS_TOKEN;
  process.env.META_ACCESS_TOKEN = "probe-token-never-sent"; // fetch is replaced below
  globalThis.fetch = async (url) => {
    sends.push(String(url));
    return new Response(JSON.stringify({ messages: [{ id: "wamid.probe" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let outcome;
  try {
    const job = {
      data: {
        broadcastId: "91919191-0000-4000-8000-0000000000b1",
        recipientId: "91919191-0000-4000-8000-0000000000c1",
        contactWaId: "971594000008",
        phoneNumberId: "940001",
        templateName: "probe",
        templateLanguage: "en",
        templateParams: [],
      },
      opts: { attempts: 3 },
      attemptsMade: 0,
    };
    outcome = await processBroadcastSendJob(job).then(() => "finished", (err) => err.message);
  } finally {
    globalThis.fetch = realFetch;
    if (realToken === undefined) delete process.env.META_ACCESS_TOKEN;
    else process.env.META_ACCESS_TOKEN = realToken;
  }
  assert.deepEqual(sends, [], "a customer was messaged for a campaign the platform has no record of");
  assert.match(outcome, /not in the database/, "the job finished instead of asking the queue to try again");
});
