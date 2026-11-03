// The workflow board's tables (3 Nov 2026, migration 107): units, deals, the
// units matched to a deal, and the move history. Every table keeps one
// business's rows to that business; cards close and are never deleted; the
// history is only ever added to; and the database itself refuses an advertised
// unit with no permit on file.
//
// The source checks always run. The database cases run only against the
// throwaway Postgres (schema.sql plus every migration), applying 107 as the
// owner and acting as the app's own role, `nexus_app`:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55433/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55433/nexus
//
// Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §4
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const MIGRATION = join(root, "packages", "db", "migrations", "107-the-workflow-board.sql");
const SQL = readFileSync(MIGRATION, "utf8");
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, "").trim();
const TABLES = ["property_units", "property_deals", "property_deal_units", "workflow_moves"];

test("the migration is one bounded transaction, safe to run twice", () => {
  assert.match(CODE, /^begin;\s*set local lock_timeout = '5s';/);
  assert.match(CODE, /commit;$/);
  for (const t of TABLES) assert.match(CODE, new RegExp(`create table if not exists ${t} \\(`), t);
  assert.doesNotMatch(CODE, /create table (?!if not exists)/);
  assert.doesNotMatch(CODE, /create (unique )?index (?!if not exists)/);
  for (const m of CODE.matchAll(/create policy (\w+) on/g)) {
    assert.match(CODE, new RegExp(`drop policy if exists ${m[1]} on`), `${m[1]} is not dropped first`);
  }
});

test("every table keeps a business's rows to that business", () => {
  for (const t of TABLES) {
    assert.match(CODE, new RegExp(`alter table ${t} enable row level security;`), t);
    const policy = CODE.slice(CODE.indexOf(`create policy ${t}_tenant_isolation on ${t}`));
    assert.ok(policy.length < CODE.length, `${t} has no tenant policy`);
    const body = policy.slice(0, policy.indexOf(";"));
    assert.match(body, /using \(organization_id::text = current_setting\('app\.current_org', true\)/, t);
    assert.match(body, /with check \(organization_id::text = current_setting\('app\.current_org', true\)/, t);
  }
});

test("cards are never deleted and the history is only added to", () => {
  assert.match(CODE, /grant select, insert, update on property_units to nexus_app;/);
  assert.match(CODE, /grant select, insert, update on property_deals to nexus_app;/);
  assert.match(CODE, /grant select, insert, delete on property_deal_units to nexus_app;/);
  assert.match(CODE, /grant select, insert on workflow_moves to nexus_app;/);
  assert.doesNotMatch(CODE, /grant [^;]*delete[^;]* on (property_units|property_deals|workflow_moves)/);
  assert.doesNotMatch(CODE, /grant [^;]*update[^;]* on workflow_moves/);
  // The database's default privileges hand nexus_app all four rights on every
  // new table (as migration 050 found), so what a grant leaves out is revoked.
  assert.match(CODE, /revoke delete on property_units from nexus_app;/);
  assert.match(CODE, /revoke delete on property_deals from nexus_app;/);
  assert.match(CODE, /revoke update on property_deal_units from nexus_app;/);
  assert.match(CODE, /revoke update, delete on workflow_moves from nexus_app;/);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const SFS = "10700000-0000-4000-8000-000000000001";
const OTHER = "10700000-0000-4000-8000-000000000002";
const SFS_STAFF = "10700000-0000-4000-8000-0000000000e1";
const SFS_LEAD = "10700000-0000-4000-8000-0000000000c1";
const SFS_UNIT = "10700000-0000-4000-8000-0000000000a1";

let owner;
let app;
let dbTurn;

/** Runs `fn(client)` as nexus_app inside `org`, then rolls back. */
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

/** The error a statement raises as nexus_app inside `org`, or null when it succeeds. */
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
  await owner.query(SQL); // the database may predate 107; the file is safe to re-run
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'wb-sfs', 'Board SFS', '910701', '810701', 'Asia/Dubai'),
            ($2, 'wb-other', 'Board Other', '910702', '810702', 'Asia/Dubai')`,
    [SFS, OTHER]
  );
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'WB1', 'Aisha')`, [SFS_STAFF, SFS]);
  await owner.query(`insert into contacts (id, organization_id, wa_id, display_name) values ($1, $2, '971507000001', 'Lead one')`, [SFS_LEAD, SFS]);
  await owner.query(`insert into property_units (id, organization_id, step, reference) values ($1, $2, 'S5', 'Marina Gate 2 · 1204')`, [SFS_UNIT, SFS]);
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id in ($1, $2)`, [SFS, OTHER]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await app.end();
  await owner.end();
});

test("another business neither sees nor writes this one's units", db, async () => {
  const seen = await asBusiness(OTHER, (c) => c.query("select id from property_units where id = $1", [SFS_UNIT]));
  assert.equal(seen.rowCount, 0);
  const mine = await asBusiness(SFS, (c) => c.query("select id from property_units where id = $1", [SFS_UNIT]));
  assert.equal(mine.rowCount, 1);
  const err = await failure(OTHER, `insert into property_units (organization_id, step, reference) values ($1, 'S5', 'Planted')`, [SFS]);
  assert.match(String(err?.message), /row-level security/);
});

test("the database refuses an advertised unit with no permit, and a rental on Sale units", db, async () => {
  const noPermit = await failure(SFS, `insert into property_units (organization_id, step, reference, purpose) values ($1, 'S9', 'No permit', 'rent')`, [SFS]);
  assert.equal(noPermit?.code, "23514");
  const permitted = await failure(
    SFS,
    `insert into property_units (organization_id, step, reference, purpose, form_a_signed_on, permit_number, permit_expires_on)
     values ($1, 'S9', 'Permitted', 'rent', '2026-10-01', '71234', '2027-10-01')`,
    [SFS]
  );
  assert.equal(permitted, null);
  const wrongBranch = await failure(SFS, `insert into property_units (organization_id, step, reference, purpose) values ($1, 'S7', 'Rental', 'rent')`, [SFS]);
  assert.equal(wrongBranch?.code, "23514");
  const unclassified = await failure(SFS, `insert into property_units (organization_id, step, reference) values ($1, 'S8', 'Unclassified')`, [SFS]);
  assert.equal(unclassified?.code, "23514");
  const blank = await failure(SFS, `insert into property_units (organization_id, step, reference) values ($1, 'S5', '  ')`, [SFS]);
  assert.equal(blank?.code, "23514");
});

test("one open deal per lead and purpose", db, async () => {
  const result = await asBusiness(SFS, async (c) => {
    await c.query(`insert into property_deals (organization_id, contact_id, step, purpose) values ($1, $2, 'D4', 'rent')`, [SFS, SFS_LEAD]);
    await c.query("savepoint again");
    let dup = null;
    try {
      await c.query(`insert into property_deals (organization_id, contact_id, step, purpose) values ($1, $2, 'D5', 'rent')`, [SFS, SFS_LEAD]);
    } catch (err) {
      dup = err;
    }
    await c.query("rollback to savepoint again");
    await c.query(`insert into property_deals (organization_id, contact_id, step, purpose) values ($1, $2, 'D4', 'sale')`, [SFS, SFS_LEAD]);
    return dup;
  });
  assert.equal(result?.code, "23505");
  const wrongDeal = await failure(SFS, `insert into property_deals (organization_id, contact_id, step, purpose) values ($1, $2, 'D8', 'rent')`, [SFS, SFS_LEAD]);
  assert.equal(wrongDeal?.code, "23514");
});

test("the history is only added to, and cards are never deleted", db, async () => {
  const ok = await failure(
    SFS,
    `insert into workflow_moves (organization_id, unit_id, kind, to_step, by_employee_id) values ($1, $2, 'created', 'S5', $3)`,
    [SFS, SFS_UNIT, SFS_STAFF]
  );
  assert.equal(ok, null);
  // A move is about exactly one card…
  const noCard = await failure(
    SFS,
    `insert into workflow_moves (organization_id, kind, to_step, by_employee_id) values ($1, 'created', 'S5', $2)`,
    [SFS, SFS_STAFF]
  );
  assert.equal(noCard?.code, "23514");
  // …by at most one person. "Exactly one" is the module's rule: a deleted
  // employee's moves keep their place in the history with nobody named.
  const twoPeople = await failure(
    SFS,
    `insert into workflow_moves (organization_id, unit_id, kind, to_step, by_employee_id, by_admin_id)
     values ($1, $2, 'created', 'S5', $3, gen_random_uuid())`,
    [SFS, SFS_UNIT, SFS_STAFF]
  );
  assert.equal(twoPeople?.code, "23514");
  assert.equal((await failure(SFS, `update workflow_moves set to_step = 'S6'`))?.code, "42501");
  assert.equal((await failure(SFS, `delete from workflow_moves`))?.code, "42501");
  assert.equal((await failure(SFS, `delete from property_units where id = $1`, [SFS_UNIT]))?.code, "42501");
  assert.equal((await failure(SFS, `delete from property_deals`))?.code, "42501");
});

test("removing a person keeps their moves, and a business with history can still be removed", db, async () => {
  const gone = "10700000-0000-4000-8000-0000000000e2";
  const temp = "10700000-0000-4000-8000-000000000003";
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'wb-temp', 'Board Temp', '910703', '810703', 'Asia/Dubai')`,
    [temp]
  );
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'WB2', 'Leaver')`, [gone, temp]);
  const { rows } = await owner.query(
    `with u as (insert into property_units (organization_id, step, reference) values ($1, 'S5', 'Temp unit') returning id)
     insert into workflow_moves (organization_id, unit_id, kind, to_step, by_employee_id) select $1, u.id, 'created', 'S5', $2 from u returning id`,
    [temp, gone]
  );
  await owner.query(`delete from employees where id = $1`, [gone]);
  const kept = await owner.query(`select by_employee_id from workflow_moves where id = $1`, [rows[0].id]);
  assert.equal(kept.rowCount, 1);
  assert.equal(kept.rows[0].by_employee_id, null);
  await owner.query(`delete from organizations where id = $1`, [temp]);
  assert.equal((await owner.query(`select 1 from workflow_moves where organization_id = $1`, [temp])).rowCount, 0);
});
