// A removed person is signed out at once (audit, 4 Nov 2026).
//
// A session is a signed cookie good for 12 hours, and nothing on the inbox or
// conversation path asked whether its holder still worked here: removing a
// salesperson at 10:00 left their open browser reading their customers and
// replying as the business until about 22:00. (Team chat alone re-checked.)
// Every signed-in request now asks whether the staff member or admin is still
// active.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "99999999-0000-4000-8000-000000000001";
const STAFF = "99999999-0000-4000-8000-0000000000e1";
const ADMIN = "99999999-0000-4000-8000-0000000000a1";
process.env.NEXUS_SESSION_SECRET = "probe-session-secret";

let owner;
let dbTurn;
let lib;
let app;
let signSession;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'signout-org', 'Sign Out', '990601', '890601', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name, is_active) values ($1, $2, 'SO1', 'Leaving Soon', true)`, [
    STAFF,
    ORG,
  ]);
  await owner.query(
    `insert into admins (id, email, full_name, password_hash, is_active) values ($1, 'leaving-admin@localhost.test', 'Leaving Admin', 'x', true)`,
    [ADMIN]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  ({ signSession } = await import("../../web/lib/auth.ts"));
  const { Hono } = await import("hono");
  const { requireAuth } = await import("../src/middleware/require-auth.ts");
  app = new Hono();
  app.use("/api/*", requireAuth);
  app.get("/api/probe", (c) => c.json({ ok: true }));
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(`delete from admins where id = $1`, [ADMIN]);
    await owner.query(`delete from employees where organization_id = $1`, [ORG]);
    await owner.query(`delete from organizations where id = $1`, [ORG]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    await lib?.getPool().end();
  }
});

const asked = async (token) => (await app.request("/api/probe", { headers: { cookie: `nexus_session=${token}` } })).status;

test("a staff member removed mid-session is refused on their next request", db, async () => {
  const token = await signSession("leaving@localhost.test", {
    role: "employee",
    employeeId: STAFF,
    organizationId: ORG,
    organizationSlug: "signout-org",
  });
  assert.equal(await asked(token), 200);
  await owner.query(`update employees set is_active = false where id = $1`, [STAFF]);
  assert.equal(await asked(token), 401, "a removed staff member's open session still worked");
  // Said so (5 Nov 2026): the screen sends them to sign in with this reason.
  const refusal = await app.request("/api/probe", { headers: { cookie: `nexus_session=${token}` } });
  assert.equal((await refusal.json()).signedOut, "removed");
});

test("so is an admin whose account was switched off", db, async () => {
  const token = await signSession("leaving-admin@localhost.test", { role: "operator", adminId: ADMIN });
  assert.equal(await asked(token), 200);
  await owner.query(`update admins set is_active = false where id = $1`, [ADMIN]);
  assert.equal(await asked(token), 401, "a switched-off admin's open session still worked");
});

test("a removed person's open live inbox is closed within a minute", async () => {
  // Checked only when the stream opened, an open tab kept receiving customer
  // messages after its person was removed (review, 4 Nov 2026).
  const { readFileSync } = await import("node:fs");
  const hub = readFileSync(new URL("../src/ws/inbox-hub.ts", import.meta.url), "utf8");
  const sweep = hub.slice(hub.indexOf("const recheck = setInterval("));
  assert.ok(sweep.length > 0, "there is a periodic re-check");
  assert.match(sweep.slice(0, 1200), /sessionHolderIsActive\(\{ employeeId: client\.employeeId \?\? undefined, adminId: client\.adminId \?\? undefined \}\)/);
  assert.match(sweep.slice(0, 1200), /client\.socket\.close\(4401/);
  assert.match(hub, /clearInterval\(recheck\)/);
});
