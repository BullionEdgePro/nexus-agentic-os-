// The board carries the listing (7 Nov 2026): the unit card saves the
// listing's details and hands back its photos (in order, without their bytes)
// and its three publish switches, with the business's feed and licence state
// the card needs to say what is missing.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §5, §9
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55440/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55440/nexus
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const SRC = readFileSync(join(root, "packages", "db", "src", "workflow-board.ts"), "utf8");
const MIGRATION = readFileSync(join(root, "packages", "db", "migrations", "110-a-unit-goes-on-the-portals.sql"), "utf8");

test("the unit select reads every listing column and never a photo's bytes", () => {
  const select = SRC.slice(SRC.indexOf("const UNIT_SELECT"), SRC.indexOf("const DEAL_SELECT"));
  for (const col of ["title", "description", "size_sqft", "bathrooms", "furnishing", "city", "sub_community", "building", "parking", "amenities", "available_from", "updated_at"]) {
    assert.match(select, new RegExp(`u\\.${col}\\b`), col);
  }
  assert.match(select, /from unit_photos/);
  assert.doesNotMatch(select, /bytes/);
  assert.match(select, /from unit_portals/);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11040000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const AISHA = id(11);
const BILAL = id(12);
const TZ = "Asia/Dubai";
const aisha = { employeeId: AISHA };
const asAisha = { employeeId: AISHA, seesAll: false };

let owner;
let dbTurn;
let lib;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(MIGRATION);
  await owner.query(`delete from organizations where id = $1`, [SFS]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'bcl-sfs', 'Listing SFS', '911041', '811041', 'Asia/Dubai')`,
    [SFS]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, brn) values ($1, $3, 'BL1', 'Aisha', '45678'), ($2, $3, 'BL2', 'Bilal', null)`,
    [AISHA, BILAL, SFS]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id = $1`, [SFS]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const board = () => lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAisha });

test("a new unit has Dubai, no photos, every switch off; the business has no feed or ORN yet", db, async () => {
  const unit = await lib.createUnit(SFS, aisha, asAisha, { reference: "Bay Square 4 · 1102" });
  assert.equal(unit.city, "Dubai");
  assert.deepEqual(unit.photos, []);
  assert.deepEqual(unit.amenities, []);
  assert.deepEqual(unit.portals, { bayut: { wanted: false }, dubizzle: { wanted: false }, property_finder: { wanted: false } });
  assert.match(unit.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const b = await board();
  assert.equal(b.portalFeed, null);
  assert.equal(b.ornSet, false);
  assert.deepEqual(b.agentBrns, { [AISHA]: true });
});

test("updateUnit saves every listing field and the board hands it back", db, async () => {
  const [unit] = (await board()).units;
  const saved = await lib.updateUnit(SFS, aisha, asAisha, unit.id, {
    title: "Bright 1-bed with canal view",
    description: "Line one.\nLine two.",
    sizeSqft: 812.5,
    bathrooms: 2,
    furnishing: "semi_furnished",
    city: "Dubai",
    subCommunity: "Bay Square",
    building: "Building 4",
    parking: 1,
    amenities: ["balcony", "central_ac"],
    availableFrom: "2026-12-01",
    agentEmployeeId: BILAL,
  });
  const again = (await board()).units.find((u) => u.id === unit.id);
  for (const card of [saved, again]) {
    assert.equal(card.title, "Bright 1-bed with canal view");
    assert.equal(card.description, "Line one.\nLine two.");
    assert.equal(card.sizeSqft, 812.5);
    assert.equal(card.bathrooms, 2);
    assert.equal(card.furnishing, "semi_furnished");
    assert.equal(card.subCommunity, "Bay Square");
    assert.equal(card.building, "Building 4");
    assert.equal(card.parking, 1);
    assert.deepEqual(card.amenities, ["balcony", "central_ac"]);
    assert.equal(card.availableFrom, "2026-12-01");
  }
  assert.deepEqual((await board()).agentBrns, { [BILAL]: false });
});

test("photos come in order without bytes; switches and the feed show through", db, async () => {
  const [unit] = (await board()).units;
  const p = (n) => id(100 + n);
  await owner.query(
    `insert into unit_photos (id, organization_id, unit_id, position, bytes, width, height, size) values
       ($1, $4, $5, 2, '\\xffd8ff', 1600, 1200, 3), ($2, $4, $5, 0, '\\xffd8ff', 2048, 1536, 3), ($3, $4, $5, 1, '\\xffd8ff', 1200, 900, 3)`,
    [p(1), p(2), p(3), SFS, unit.id]
  );
  await owner.query(`insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, 'dubizzle', true)`, [SFS, unit.id]);
  await owner.query(`insert into portal_settings (organization_id, orn, feed_token, feed_last_read_at) values ($1, '12345', 'tok-bcl', '2026-11-07T06:42:00Z')`, [SFS]);
  const b = await board();
  const card = b.units.find((u) => u.id === unit.id);
  assert.deepEqual(card.photos, [
    { id: p(2), width: 2048, height: 1536 },
    { id: p(3), width: 1200, height: 900 },
    { id: p(1), width: 1600, height: 1200 },
  ]);
  assert.deepEqual(card.portals, { bayut: { wanted: false }, dubizzle: { wanted: true }, property_finder: { wanted: false } });
  assert.deepEqual(b.portalFeed, { lastReadAt: "2026-11-07T06:42:00.000Z" });
  assert.equal(b.ornSet, true);
});
