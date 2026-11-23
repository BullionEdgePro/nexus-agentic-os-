// A unit goes on Bayut (23 Nov 2026, migration 113): the business's Bayut token
// is kept sealed on its portal settings with what the last check said, each
// Nexus agent is linked to a Bayut user, each unit holds a Bayut location, and
// a unit's Bayut row keeps two more answers (draft, pending), the publish time
// and the permit comment.
//
// The source checks always run. The database cases run only against the
// throwaway Postgres (schema.sql plus every migration); the test applies 113
// itself, twice, as the owner and then acts as the app's own role, `nexus_app`:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55441/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55441/nexus
//
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §5, §6, §13
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const MIGRATION = join(root, "packages", "db", "migrations", "113-a-unit-goes-on-bayut.sql");
const SQL = readFileSync(MIGRATION, "utf8");
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, "").trim();
const BAYUT_SETTINGS = ["bayut_token_sealed", "bayut_token_ending", "bayut_agency_id", "bayut_agency_name", "bayut_checked_at", "bayut_check_error"];

test("the migration is one bounded transaction, safe to run twice", () => {
  assert.match(CODE, /^begin;\s*set local lock_timeout = '5s';/);
  assert.match(CODE, /commit;$/);
  assert.doesNotMatch(CODE, /add column (?!if not exists)/);
  for (const m of CODE.matchAll(/add constraint (\w+)/g)) {
    assert.match(CODE, new RegExp(`drop constraint if exists ${m[1]}`), m[1]);
  }
  for (const c of BAYUT_SETTINGS) assert.match(CODE, new RegExp(`add column if not exists ${c} `), c);
  for (const c of ["bayut_location_id integer", "bayut_location_name text", "published_at timestamptz", "permit_comment text"]) {
    assert.match(CODE, new RegExp(`add column if not exists ${c}`), c);
  }
  assert.match(CODE, /create table if not exists bayut_agents \(/);
  assert.match(CODE, /primary key \(organization_id, employee_id\)/);
  assert.match(CODE, /alter table bayut_agents enable row level security;/);
  assert.match(CODE, /create policy bayut_agents_tenant_isolation on bayut_agents/);
  assert.match(CODE, /grant select, insert, update, delete on bayut_agents to nexus_app;/);
  assert.match(CODE, /revoke truncate, references, trigger on bayut_agents from nexus_app;/);
  assert.match(CODE, /remote_state in \('live', 'unpublished', 'refused', 'failed', 'draft', 'pending'\)/);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const A = "11300000-0000-4000-8000-000000000001";
const B = "11300000-0000-4000-8000-000000000002";
const A_UNIT = "11300000-0000-4000-8000-0000000000a1";
const A_EMP = "11300000-0000-4000-8000-0000000000e1";
const B_EMP = "11300000-0000-4000-8000-0000000000e2";

let owner;
let app;
let dbTurn;

async function asBusiness(org, fn) {
  const client = await app.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.current_org', $1, true)", [org]);
    return await fn(client);
  } finally {
    await client.query("rollback");
    client.release();
  }
}

const failure = (org, sql, args = []) =>
  asBusiness(org, async (c) => {
    try {
      await c.query(sql, args);
      return null;
    } catch (err) {
      return err;
    }
  });

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  app = new pg.Pool({ connectionString: APP_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(SQL);
  await owner.query(SQL); // safe to run twice
  await owner.query(`delete from organizations where id in ($1, $2)`, [A, B]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'bayut-a', 'Bayut A', '911301', '811301', 'Asia/Dubai'),
            ($2, 'bayut-b', 'Bayut B', '911302', '811302', 'Asia/Dubai')`,
    [A, B]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email) values ($1, $2, 'BA1', 'Agent A', 'a@example.test'), ($3, $4, 'BB1', 'Agent B', 'b@example.test')`,
    [A_EMP, A, B_EMP, B]
  );
  await owner.query(`insert into property_units (id, organization_id, step, reference) values ($1, $2, 'S5', 'Marina 1 · 101')`, [A_UNIT, A]);
  await owner.query(`insert into portal_settings (organization_id) values ($1)`, [A]);
  await owner.query(`insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, 'bayut', true)`, [A, A_UNIT]);
  await owner.query(
    `insert into bayut_agents (organization_id, employee_id, bayut_user_id, bayut_user_name) values ($1, $2, 11, 'Agent A'), ($3, $4, 22, 'Agent B')`,
    [A, A_EMP, B, B_EMP]
  );
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id in ($1, $2)`, [A, B]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await app.end();
  await owner.end();
});

test("the token columns are there, and the ending is four characters at most", db, async () => {
  const row = await asBusiness(A, async (c) => {
    await c.query(
      `update portal_settings set bayut_token_sealed = 'a:b:c', bayut_token_ending = 'wxyz', bayut_agency_id = 7,
              bayut_agency_name = 'SFS', bayut_checked_at = now(), bayut_check_error = null
        where organization_id = $1`,
      [A]
    );
    return (await c.query(`select ${BAYUT_SETTINGS.join(", ")} from portal_settings where organization_id = $1`, [A])).rows[0];
  });
  assert.equal(row.bayut_token_ending, "wxyz");
  assert.equal(row.bayut_agency_id, 7);
  const bad = await failure(A, `update portal_settings set bayut_token_ending = 'abcde' where organization_id = $1`, [A]);
  assert.equal(bad?.code, "23514");
  const long = await failure(A, `update portal_settings set bayut_check_error = repeat('x', 401) where organization_id = $1`, [A]);
  assert.equal(long?.code, "23514");
});

test("a business sees only its own agent links", db, async () => {
  const rows = await asBusiness(A, async (c) => (await c.query(`select employee_id from bayut_agents`)).rows);
  assert.deepEqual(rows.map((r) => r.employee_id), [A_EMP]);
  const crossWrite = await failure(A, `insert into bayut_agents (organization_id, employee_id, bayut_user_id) values ($1, $2, 5)`, [B, B_EMP]);
  assert.equal(crossWrite?.code, "42501");
});

test("an agent link can be changed and removed, never truncated; the Bayut user id must be positive", db, async () => {
  const gone = await asBusiness(A, async (c) => {
    await c.query(`update bayut_agents set bayut_user_id = 12 where employee_id = $1`, [A_EMP]);
    await c.query(`delete from bayut_agents where employee_id = $1`, [A_EMP]);
    return (await c.query(`select count(*)::int as n from bayut_agents`)).rows[0].n;
  });
  assert.equal(gone, 0);
  const bad = await failure(A, `update bayut_agents set bayut_user_id = 0 where employee_id = $1`, [A_EMP]);
  assert.equal(bad?.code, "23514");
  const truncate = await failure(A, `truncate bayut_agents`);
  assert.equal(truncate?.code, "42501");
});

test("a Bayut location is an id with its name, or neither", db, async () => {
  const ok = await asBusiness(A, async (c) => {
    await c.query(`update property_units set bayut_location_id = 5003, bayut_location_name = 'UAE > Dubai > Marina > Marina Gate' where id = $1`, [A_UNIT]);
    return (await c.query(`select bayut_location_id, bayut_location_name from property_units where id = $1`, [A_UNIT])).rows[0];
  });
  assert.equal(ok.bayut_location_id, 5003);
  const idOnly = await failure(A, `update property_units set bayut_location_id = 5003 where id = $1`, [A_UNIT]);
  assert.equal(idOnly?.code, "23514");
  const nameOnly = await failure(A, `update property_units set bayut_location_name = 'Marina' where id = $1`, [A_UNIT]);
  assert.equal(nameOnly?.code, "23514");
  const zero = await failure(A, `update property_units set bayut_location_id = 0, bayut_location_name = 'x' where id = $1`, [A_UNIT]);
  assert.equal(zero?.code, "23514");
  const longName = await failure(A, `update property_units set bayut_location_id = 1, bayut_location_name = repeat('x', 301) where id = $1`, [A_UNIT]);
  assert.equal(longName?.code, "23514");
});

test("a unit's Bayut answer may be draft or pending, with a publish time and a permit comment", db, async () => {
  const row = await asBusiness(A, async (c) => {
    await c.query(
      `update unit_portals set remote_state = 'pending', published_at = now(), permit_comment = 'Waiting for the permit check'
        where unit_id = $1 and portal = 'bayut'`,
      [A_UNIT]
    );
    return (await c.query(`select remote_state, permit_comment, published_at is not null as has_time from unit_portals where unit_id = $1`, [A_UNIT])).rows[0];
  });
  assert.deepEqual(row, { remote_state: "pending", permit_comment: "Waiting for the permit check", has_time: true });
  for (const state of ["draft", "live", "unpublished", "refused", "failed"]) {
    assert.equal(await failure(A, `update unit_portals set remote_state = $2 where unit_id = $1`, [A_UNIT, state]), null, state);
  }
  const bad = await failure(A, `update unit_portals set remote_state = 'deleted' where unit_id = $1`, [A_UNIT]);
  assert.equal(bad?.code, "23514");
  const longComment = await failure(A, `update unit_portals set permit_comment = repeat('x', 301) where unit_id = $1`, [A_UNIT]);
  assert.equal(longComment?.code, "23514");
});
