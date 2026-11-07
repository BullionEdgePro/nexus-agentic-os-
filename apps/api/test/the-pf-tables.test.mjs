// A key for Property Finder (7 Nov 2026, migration 111): the business's API key
// and secret are kept sealed on its portal settings with what the last check
// said, and each unit's Property Finder row remembers what was last sent (a
// fingerprint) and Property Finder's answer in one of four words.
//
// The source checks always run. The database cases run only against the
// throwaway Postgres (schema.sql plus every migration), applying 111 as the
// owner and acting as the app's own role, `nexus_app`:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55440/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55440/nexus
//
// Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §3, §5
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const MIGRATION = join(root, "packages", "db", "migrations", "111-a-key-for-property-finder.sql");
const SQL = readFileSync(MIGRATION, "utf8");
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, "").trim();
const PF_COLUMNS = ["pf_key_sealed", "pf_secret_sealed", "pf_key_ending", "pf_environment", "pf_checked_at", "pf_check_error"];

test("the migration is one bounded transaction, safe to run twice", () => {
  assert.match(CODE, /^begin;\s*set local lock_timeout = '5s';/);
  assert.match(CODE, /commit;$/);
  assert.doesNotMatch(CODE, /add column (?!if not exists)/);
  for (const m of CODE.matchAll(/add constraint (\w+)/g)) {
    assert.match(CODE, new RegExp(`drop constraint if exists ${m[1]}`), m[1]);
  }
  for (const c of PF_COLUMNS) assert.match(CODE, new RegExp(`add column if not exists ${c} `), c);
  assert.match(CODE, /add column if not exists remote_fingerprint text/);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const SFS = "11100000-0000-4000-8000-000000000001";
const SFS_UNIT = "11100000-0000-4000-8000-0000000000a1";

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
  await owner.query(`delete from organizations where id = $1`, [SFS]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'pf-sfs', 'PF SFS', '911101', '811101', 'Asia/Dubai')`,
    [SFS]
  );
  await owner.query(`insert into property_units (id, organization_id, step, reference) values ($1, $2, 'S5', 'Marina 1 · 101')`, [SFS_UNIT, SFS]);
  await owner.query(`insert into portal_settings (organization_id) values ($1)`, [SFS]);
  await owner.query(`insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, 'property_finder', true)`, [SFS, SFS_UNIT]);
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id = $1`, [SFS]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await app.end();
  await owner.end();
});

test("the key columns are there, and Sandbox or Live is all the environment can be", db, async () => {
  const ok = await asBusiness(SFS, async (c) => {
    await c.query(
      `update portal_settings set pf_key_sealed = 'a:b:c', pf_secret_sealed = 'd:e:f', pf_key_ending = '1a2b',
              pf_environment = 'sandbox', pf_checked_at = now(), pf_check_error = null
        where organization_id = $1`,
      [SFS]
    );
    return (await c.query(`select ${PF_COLUMNS.join(", ")} from portal_settings where organization_id = $1`, [SFS])).rows[0];
  });
  assert.equal(ok.pf_environment, "sandbox");
  assert.equal(ok.pf_key_ending, "1a2b");
  const bad = await failure(SFS, `update portal_settings set pf_environment = 'staging' where organization_id = $1`, [SFS]);
  assert.equal(bad?.code, "23514");
});

test("a unit's Property Finder answer is one of four words, with a fingerprint of what was sent", db, async () => {
  const row = await asBusiness(SFS, async (c) => {
    await c.query(
      `update unit_portals set remote_state = 'live', remote_fingerprint = 'abc' where unit_id = $1 and portal = 'property_finder'`,
      [SFS_UNIT]
    );
    return (await c.query(`select remote_state, remote_fingerprint from unit_portals where unit_id = $1`, [SFS_UNIT])).rows[0];
  });
  assert.deepEqual(row, { remote_state: "live", remote_fingerprint: "abc" });
  for (const state of ["unpublished", "refused", "failed"]) {
    assert.equal(await failure(SFS, `update unit_portals set remote_state = $2 where unit_id = $1`, [SFS_UNIT, state]), null, state);
  }
  const bad = await failure(SFS, `update unit_portals set remote_state = 'gone' where unit_id = $1`, [SFS_UNIT]);
  assert.equal(bad?.code, "23514");
});

test("the settings are still never deleted by the app", db, async () => {
  const bad = await failure(SFS, `delete from portal_settings where organization_id = $1`, [SFS]);
  assert.equal(bad?.code, "42501");
});
