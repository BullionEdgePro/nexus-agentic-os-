// A unit kept off-market (7 Nov 2026, migration 112): a pocket switch on the
// unit, and the private links it is shared by — one per buyer while active,
// each with its own unguessable token, never deleted, a business's own.
//
// The source checks always run. The database cases run only against the
// throwaway Postgres (schema.sql plus every migration), applying 112 as the
// owner and acting as the app's own role, `nexus_app`:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55440/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55440/nexus
//
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §8
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const SQL = readFileSync(join(root, "packages", "db", "migrations", "112-a-unit-kept-off-market.sql"), "utf8");
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, "").trim();

test("the migration is one bounded transaction, safe to run twice", () => {
  assert.match(CODE, /^begin;\s*set local lock_timeout = '5s';/);
  assert.match(CODE, /commit;$/);
  assert.match(CODE, /create table if not exists unit_pocket_shares \(/);
  assert.doesNotMatch(CODE, /create table (?!if not exists)/);
  assert.doesNotMatch(CODE, /create (unique )?index (?!if not exists)/);
  assert.doesNotMatch(CODE, /add column (?!if not exists)/);
  for (const m of CODE.matchAll(/add constraint (\w+)/g)) {
    assert.match(CODE, new RegExp(`drop constraint if exists ${m[1]}`), m[1]);
  }
  assert.match(CODE, /add column if not exists pocket boolean not null default false/);
  assert.match(CODE, /add column if not exists pocket_since timestamptz/);
  assert.match(CODE, /revoke delete on unit_pocket_shares from nexus_app/);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const OTHER = id(2);
const UNIT = id(11);
const CONTACT = id(21);
const DEAL = id(31);
const T = (c) => c.repeat(43);

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
const share = (token, extra = "") =>
  `insert into unit_pocket_shares (organization_id, unit_id, deal_id, token, expires_at${extra ? ", " + extra.split("=")[0] : ""})
   values ($1, $2, $3, '${token}', now() + interval '14 days'${extra ? ", " + extra.split("=")[1] : ""})`;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  app = new pg.Pool({ connectionString: APP_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(SQL);
  await owner.query(SQL); // safe to run twice
  await owner.query(`delete from organizations where id in ($1, $2)`, [SFS, OTHER]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'pk-sfs', 'Pocket SFS', '911201', '811201', 'Asia/Dubai'),
            ($2, 'pk-other', 'Pocket Other', '911202', '811202', 'Asia/Dubai')`,
    [SFS, OTHER]
  );
  await owner.query(`insert into property_units (id, organization_id, step, reference) values ($1, $2, 'S5', 'Palm villa 12')`, [UNIT, SFS]);
  await owner.query(`insert into contacts (id, organization_id, wa_id, display_name) values ($1, $2, '971501112233', 'Sara Khan')`, [CONTACT, SFS]);
  await owner.query(`insert into property_deals (id, organization_id, contact_id, step, purpose) values ($1, $2, $3, 'D5', 'sale')`, [DEAL, SFS, CONTACT]);
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

test("a unit is not a pocket listing until someone says so", db, async () => {
  const r = (await owner.query(`select pocket, pocket_since from property_units where id = $1`, [UNIT])).rows[0];
  assert.deepEqual(r, { pocket: false, pocket_since: null });
});

test("a share has a 43-character token and a count that is never negative", db, async () => {
  const short = await failure(SFS, share("a".repeat(42)), [SFS, UNIT, DEAL]);
  assert.equal(short?.code, "23514");
  const negative = await failure(SFS, share(T("b"), "view_count=-1"), [SFS, UNIT, DEAL]);
  assert.equal(negative?.code, "23514");
});

test("one active share per unit and buyer; a revoked one makes room", db, async () => {
  const twice = await asBusiness(SFS, async (c) => {
    await c.query(share(T("c")), [SFS, UNIT, DEAL]);
    try {
      await c.query(share(T("d")), [SFS, UNIT, DEAL]);
      return null;
    } catch (err) {
      return err;
    }
  });
  assert.equal(twice?.code, "23505");
  const after = await asBusiness(SFS, async (c) => {
    await c.query(share(T("e"), "revoked_at=now()"), [SFS, UNIT, DEAL]);
    await c.query(share(T("f")), [SFS, UNIT, DEAL]);
    return (await c.query(`select count(*)::int as n from unit_pocket_shares where unit_id = $1`, [UNIT])).rows[0].n;
  });
  assert.equal(after, 2);
});

test("a business sees only its own shares, and the app never deletes one", db, async () => {
  await owner.query(share(T("g")), [SFS, UNIT, DEAL]);
  const seen = await asBusiness(OTHER, async (c) => (await c.query(`select count(*)::int as n from unit_pocket_shares`)).rows[0].n);
  assert.equal(seen, 0);
  const gone = await failure(SFS, `delete from unit_pocket_shares where unit_id = $1`, [UNIT]);
  assert.equal(gone?.code, "42501");
});
