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

test("a handler that swallowed a failure after writing answers 500", db, async () => {
  const response = await app.request("/api/organizations/srb-org/swallows/971595000008", { method: "POST" });
  assert.equal(response.status, 500, "the request answered success with its write lost");
  assert.equal(await contactNamed("971595000008"), 0);
});
