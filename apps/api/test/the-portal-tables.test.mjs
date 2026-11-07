// A unit goes on the portals (7 Nov 2026, migration 110): the listing's own
// details on the unit, its photos, a publish switch per portal, the business's
// feed settings, and each agent's broker licence (BRN). Every new table keeps a
// business's rows to that business; a switch is only ever turned off, never
// deleted; the database itself refuses a photo too small for the portals, an
// amenity it does not know and a licence number with letters in it.
//
// The source checks always run. The database cases run only against the
// throwaway Postgres (schema.sql plus every migration), applying 110 as the
// owner and acting as the app's own role, `nexus_app`:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55440/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55440/nexus
//
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §3, §10
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const MIGRATION = join(root, "packages", "db", "migrations", "110-a-unit-goes-on-the-portals.sql");
const SQL = readFileSync(MIGRATION, "utf8");
const CODE = SQL.replace(/^\s*--[^\n]*$/gm, "").trim();
const TABLES = ["unit_photos", "unit_portals", "portal_settings"];
const AMENITIES = [
  "balcony", "built_in_wardrobes", "central_ac", "covered_parking", "maids_room", "private_pool",
  "shared_pool", "private_garden", "shared_gym", "security", "concierge", "view_of_water",
  "view_of_landmark", "pets_allowed", "kitchen_appliances", "study", "childrens_play_area", "barbecue_area",
];

test("the migration is one bounded transaction, safe to run twice", () => {
  assert.match(CODE, /^begin;\s*set local lock_timeout = '5s';/);
  assert.match(CODE, /commit;$/);
  for (const t of TABLES) assert.match(CODE, new RegExp(`create table if not exists ${t} \\(`), t);
  assert.doesNotMatch(CODE, /create table (?!if not exists)/);
  assert.doesNotMatch(CODE, /create (unique )?index (?!if not exists)/);
  assert.doesNotMatch(CODE, /add column (?!if not exists)/);
  for (const m of CODE.matchAll(/create policy (\w+) on/g)) {
    assert.match(CODE, new RegExp(`drop policy if exists ${m[1]} on`), `${m[1]} is not dropped first`);
  }
  for (const m of CODE.matchAll(/add constraint (\w+)/g)) {
    assert.match(CODE, new RegExp(`drop constraint if exists ${m[1]}`), `${m[1]} is not dropped first`);
  }
});

test("every new table keeps a business's rows to that business", () => {
  for (const t of TABLES) {
    assert.match(CODE, new RegExp(`alter table ${t} enable row level security;`), t);
    const policy = CODE.slice(CODE.indexOf(`create policy ${t}_tenant_isolation on ${t}`));
    assert.ok(policy.length < CODE.length, `${t} has no tenant policy`);
    const body = policy.slice(0, policy.indexOf(";"));
    assert.match(body, /using \(organization_id::text = current_setting\('app\.current_org', true\)/, t);
    assert.match(body, /with check \(organization_id::text = current_setting\('app\.current_org', true\)/, t);
  }
});

test("photos may be removed; switches and settings are only ever changed", () => {
  assert.match(CODE, /grant select, insert, update, delete on unit_photos to nexus_app;/);
  assert.match(CODE, /grant select, insert, update on unit_portals to nexus_app;/);
  assert.match(CODE, /grant select, insert, update on portal_settings to nexus_app;/);
  // Default privileges hand nexus_app every right on a new table (050, 107).
  assert.match(CODE, /revoke delete on unit_portals from nexus_app;/);
  assert.match(CODE, /revoke delete on portal_settings from nexus_app;/);
});

test("the amenity list in the database is the spec's eighteen, in order", () => {
  const list = CODE.match(/amenities <@ array\[([^\]]+)\]::text\[\]/);
  assert.ok(list, "amenities are not checked against a list");
  assert.deepEqual([...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), AMENITIES);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const SFS = "11000000-0000-4000-8000-000000000001";
const OTHER = "11000000-0000-4000-8000-000000000002";
const SFS_STAFF = "11000000-0000-4000-8000-0000000000e1";
const SFS_UNIT = "11000000-0000-4000-8000-0000000000a1";
const SFS_PHOTO = "11000000-0000-4000-8000-0000000000f1";

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
  await owner.query(`delete from organizations where id in ($1, $2)`, [SFS, OTHER]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'pl-sfs', 'Portal SFS', '911001', '811001', 'Asia/Dubai'),
            ($2, 'pl-other', 'Portal Other', '911002', '811002', 'Asia/Dubai')`,
    [SFS, OTHER]
  );
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'PL1', 'Aisha')`, [SFS_STAFF, SFS]);
  await owner.query(`insert into property_units (id, organization_id, step, reference) values ($1, $2, 'S5', 'Bay Square 4 · 1102')`, [SFS_UNIT, SFS]);
  await owner.query(
    `insert into unit_photos (id, organization_id, unit_id, position, bytes, width, height, size) values ($1, $2, $3, 0, '\\xffd8ff', 1600, 1200, 3)`,
    [SFS_PHOTO, SFS, SFS_UNIT]
  );
  await owner.query(`insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, 'bayut', true)`, [SFS, SFS_UNIT]);
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

test("a unit keeps its listing details, with Dubai as the city by default", db, async () => {
  const row = await asBusiness(SFS, async (c) => {
    await c.query(
      `update property_units set title = 'Bright 1-bed', description = 'Canal view', size_sqft = 812.5, bathrooms = 2,
              furnishing = 'unfurnished', sub_community = 'Bay Square', building = 'Building 4', parking = 1,
              amenities = array['balcony', 'central_ac'], available_from = '2026-12-01' where id = $1`,
      [SFS_UNIT]
    );
    return (await c.query(`select city, size_sqft::text, amenities from property_units where id = $1`, [SFS_UNIT])).rows[0];
  });
  assert.deepEqual(row, { city: "Dubai", size_sqft: "812.50", amenities: ["balcony", "central_ac"] });
});

test("amenities refuse an unknown key", db, async () => {
  const err = await failure(SFS, `update property_units set amenities = array['helipad'] where id = $1`, [SFS_UNIT]);
  assert.equal(err?.code, "23514");
});

test("a photo below 800 wide is refused by the table", db, async () => {
  const err = await failure(
    SFS,
    `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size) values ($1, $2, 1, '\\xffd8ff', 799, 600, 3)`,
    [SFS, SFS_UNIT]
  );
  assert.equal(err?.code, "23514");
});

test("a BRN with letters is refused", db, async () => {
  const err = await failure(SFS, `update employees set brn = '12AB' where id = $1`, [SFS_STAFF]);
  assert.equal(err?.code, "23514");
  const ok = await failure(SFS, `update employees set brn = '45678' where id = $1`, [SFS_STAFF]);
  assert.equal(ok, null);
});

test("nexus_app cannot delete a unit_portals row", db, async () => {
  const err = await failure(SFS, `delete from unit_portals where unit_id = $1`, [SFS_UNIT]);
  assert.match(String(err?.message), /permission denied/);
});

test("another business's photos are invisible to nexus_app in this business's context", db, async () => {
  const seen = await asBusiness(OTHER, (c) => c.query("select id from unit_photos where id = $1", [SFS_PHOTO]));
  assert.equal(seen.rowCount, 0);
  const mine = await asBusiness(SFS, (c) => c.query("select id from unit_photos where id = $1", [SFS_PHOTO]));
  assert.equal(mine.rowCount, 1);
});

test("an ORN with letters is refused, and one feed address belongs to one business", db, async () => {
  const bad = await failure(SFS, `insert into portal_settings (organization_id, orn) values ($1, 'ORN-1')`, [SFS]);
  assert.equal(bad?.code, "23514");
  await owner.query(`insert into portal_settings (organization_id, orn, feed_token) values ($1, '12345', 'tok-one')`, [SFS]);
  const clash = await failure(OTHER, `insert into portal_settings (organization_id, feed_token) values ($1, 'tok-one')`, [OTHER]);
  assert.equal(clash?.code, "23505");
});
