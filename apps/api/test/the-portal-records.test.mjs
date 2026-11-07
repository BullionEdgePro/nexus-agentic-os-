// The portal records (7 Nov 2026): a unit's photos in order, its publish
// switches, the business's ORN and feed address, each agent's BRN, and what the
// feed publishes — decided when it is read (wanted AND ready), never stored, so
// a permit that expires or a card that closes leaves the portals by itself.
// Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §3, §5, §6
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
const SRC = readFileSync(join(root, "packages", "db", "src", "portal-listings.ts"), "utf8");
const MIGRATION = readFileSync(join(root, "packages", "db", "migrations", "110-a-unit-goes-on-the-portals.sql"), "utf8");

function body(name) {
  const start = SRC.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is not exported`);
  const next = SRC.indexOf("\nexport ", start + 1);
  return SRC.slice(start, next < 0 ? undefined : next);
}

const IN_BUSINESS = [
  "addUnitPhoto", "unitPhotoBytes", "orderUnitPhotos", "removeUnitPhoto", "setUnitPortal", "portalSettings",
  "setPortalOrn", "newPortalFeed", "publishedListings", "noteFeedRead", "setEmployeeBrn", "portalAgents",
];

test("everything runs as the business; only the two public lookups look across businesses, once", () => {
  for (const name of IN_BUSINESS) {
    assert.match(body(name), /withTenant\(organizationId,/, name);
    assert.doesNotMatch(body(name), /withAllTenants/, name);
  }
  for (const name of ["feedByToken", "publicPhoto"]) {
    assert.equal(body(name).match(/withAllTenants\(/g)?.length, 1, name);
  }
  assert.match(body("publicPhoto"), /withTenant\(/);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11050000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const OTHER = id(2);
const AISHA = id(11);
const OTHER_STAFF = id(12);
const TZ = "Asia/Dubai";
const TODAY = "2026-11-07";
const aisha = { employeeId: AISHA };
const asAisha = { employeeId: AISHA, seesAll: false };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const photo = { bytes: JPEG, width: 2048, height: 1536 };
const url = (photoId) => `https://api.nexusagenticos.com/portal-photos/${photoId}.jpg`;

let owner;
let dbTurn;
let lib;
let unit; // ready to list once it has photos
let token;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(MIGRATION);
  await owner.query(`delete from organizations where id in ($1, $2)`, [SFS, OTHER]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'prc-sfs', 'Records SFS', '911051', '811051', 'Asia/Dubai'),
            ($2, 'prc-other', 'Records Other', '911052', '811052', 'Asia/Dubai')`,
    [SFS, OTHER]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email, whatsapp_number, brn)
     values ($1, $3, 'PR1', 'Aisha Khan', 'aisha@sfs.ae', '971501112233', '45678'),
            ($2, $4, 'PR2', 'Other agent', null, null, null)`,
    [AISHA, OTHER_STAFF, SFS, OTHER]
  );
  const { rows } = await owner.query(
    `insert into property_units (organization_id, step, reference, community, property_type, bedrooms, purpose, price_aed,
                                 form_a_signed_on, permit_number, permit_expires_on, agent_employee_id, title, description,
                                 size_sqft, bathrooms, furnishing, sub_community, building, amenities, notes, updated_at)
     values ($1, 'S9', 'Bay Square 4 · 1102', 'Business Bay', 'apartment', 1, 'rent', 95000,
             '2026-10-28', '71450', '2027-10-27', $2, 'Bright 1-bed with canal view',
             'A bright one-bedroom apartment on a high floor, with a balcony over the canal.',
             812, 2, 'unfurnished', 'Bay Square', 'Building 4', array['balcony'], 'Owner wants a family', '2026-11-06T09:30:00Z')
     returning id`,
    [SFS, AISHA]
  );
  unit = rows[0].id;
  await owner.query(`insert into portal_settings (organization_id, orn) values ($1, '12345')`, [SFS]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id in ($1, $2)`, [SFS, OTHER]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const positions = async () =>
  (await owner.query(`select id, position from unit_photos where unit_id = $1 order by position`, [unit])).rows;

test("1. switching on a unit that is not ready is refused with the sentence; off is always allowed", db, async () => {
  const refused = await lib.setUnitPortal(SFS, unit, "bayut", true, aisha, asAisha, TODAY);
  assert.deepEqual(refused, { refused: "Before it can go on the portals: 3 photos." });
  const off = await lib.setUnitPortal(SFS, unit, "bayut", false, aisha, asAisha, TODAY);
  assert.deepEqual(off.portals.bayut, { wanted: false, state: null, message: null, syncedAt: null });
  assert.equal(await lib.setUnitPortal(SFS, id(999), "bayut", false, aisha, asAisha, TODAY), null);
});

test("2. photos go in order, up to thirty", db, async () => {
  const added = [];
  for (let i = 0; i < 30; i++) added.push((await lib.addUnitPhoto(SFS, unit, photo, aisha)).id);
  assert.deepEqual((await positions()).map((p) => p.id), added);
  assert.deepEqual(await lib.addUnitPhoto(SFS, unit, photo, aisha), { refused: "A unit has at most 30 photos." });
  assert.deepEqual(await lib.unitPhotoBytes(SFS, unit, added[0]), JPEG);
  assert.equal(await lib.unitPhotoBytes(OTHER, unit, added[0]), null);
  // Back to five for the rest.
  for (const photoId of added.slice(5)) assert.equal(await lib.removeUnitPhoto(SFS, unit, photoId, aisha), true);
  assert.equal((await positions()).length, 5);
});

test("3. removing the middle photo closes the gap", db, async () => {
  const before = (await positions()).map((p) => p.id);
  assert.equal(await lib.removeUnitPhoto(SFS, unit, before[2], aisha), true);
  assert.deepEqual(await positions(), [before[0], before[1], before[3], before[4]].map((photoId, position) => ({ id: photoId, position })));
  assert.equal(await lib.removeUnitPhoto(SFS, unit, before[2], aisha), false);
});

test("4. an order that does not name every photo is refused whole", db, async () => {
  const ids = (await positions()).map((p) => p.id);
  const words = { refused: "The order must list each of this unit's photos once." };
  assert.deepEqual(await lib.orderUnitPhotos(SFS, unit, ids.slice(1), aisha), words);
  assert.deepEqual(await lib.orderUnitPhotos(SFS, unit, [ids[0], ids[0], ids[1], ids[2]], aisha), words);
  assert.deepEqual((await positions()).map((p) => p.id), ids);
  const reversed = [...ids].reverse();
  assert.equal(await lib.orderUnitPhotos(SFS, unit, reversed, aisha), true);
  assert.deepEqual((await positions()).map((p) => p.id), reversed);
  assert.equal(await lib.orderUnitPhotos(SFS, id(999), reversed, aisha), null);
});

test("5. a ready unit switches on, and the feed publishes it without anything private", db, async () => {
  const on = await lib.setUnitPortal(SFS, unit, "bayut", true, aisha, asAisha, TODAY);
  assert.deepEqual(on.portals.bayut, { wanted: true, state: null, message: null, syncedAt: null });
  await lib.setUnitPortal(SFS, unit, "property_finder", true, aisha, asAisha, TODAY);
  const listings = await lib.publishedListings(SFS, ["bayut", "dubizzle"], TODAY, url);
  assert.equal(listings.length, 1);
  const [l] = listings;
  assert.equal(l.reference, unit);
  assert.deepEqual(l.portals, ["bayut"]);
  assert.deepEqual(l.agent, { name: "Aisha Khan", email: "aisha@sfs.ae", phone: "971501112233", brn: "45678" });
  assert.equal(l.orn, "12345");
  assert.deepEqual(l.photoUrls, (await positions()).map((p) => url(p.id)));
  assert.equal(JSON.stringify(l).includes("Owner wants a family"), false);
  assert.deepEqual(await lib.publishedListings(OTHER, ["bayut", "dubizzle"], TODAY, url), []);
});

test("6. the feed drops a unit whose permit expired, and takes it back when renewed", db, async () => {
  assert.deepEqual(await lib.publishedListings(SFS, ["bayut"], "2027-10-28", url), []);
  const still = (await lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAisha })).units.find((u) => u.id === unit);
  assert.equal(still.portals.bayut.wanted, true);
  assert.equal((await lib.publishedListings(SFS, ["bayut"], "2027-10-27", url)).length, 1);
});

test("7. public photos answer only while the unit is open and published", db, async () => {
  const [first] = await positions();
  assert.deepEqual(await lib.publicPhoto(first.id), JPEG);
  await lib.setUnitPortal(SFS, unit, "bayut", false, aisha, asAisha, TODAY);
  await lib.setUnitPortal(SFS, unit, "property_finder", false, aisha, asAisha, TODAY);
  assert.equal(await lib.publicPhoto(first.id), null);
  await lib.setUnitPortal(SFS, unit, "dubizzle", true, aisha, asAisha, TODAY);
  assert.deepEqual(await lib.publicPhoto(first.id), JPEG);
  assert.equal(await lib.publicPhoto(id(998)), null);
});

test("8. a closed unit is not published, and its photos go dark", db, async () => {
  const [first] = await positions();
  await owner.query(`update property_units set closed_at = now(), closed_reason = 'let' where id = $1`, [unit]);
  assert.deepEqual(await lib.publishedListings(SFS, ["bayut", "dubizzle"], TODAY, url), []);
  assert.equal(await lib.publicPhoto(first.id), null);
  assert.equal(await lib.setUnitPortal(SFS, unit, "bayut", true, aisha, asAisha, TODAY), "closed");
  assert.equal(await lib.addUnitPhoto(SFS, unit, photo, aisha), null);
  await owner.query(`update property_units set closed_at = null, closed_reason = null where id = $1`, [unit]);
});

test("9. the feed address finds only its business; a new address kills the old", db, async () => {
  assert.deepEqual(await lib.portalSettings(SFS), { orn: "12345", feedToken: null, feedLastReadAt: null, feedLastReadBy: null });
  token = await lib.newPortalFeed(SFS);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(await lib.feedByToken(token), { organizationId: SFS, timezone: TZ });
  const next = await lib.newPortalFeed(SFS);
  assert.notEqual(next, token);
  assert.equal(await lib.feedByToken(token), null);
  assert.equal(await lib.feedByToken("nope"), null);
  token = next;
});

test("10. a feed read is noted at most once a minute", db, async () => {
  await lib.noteFeedRead(SFS, "BayutBot/1.0");
  const first = await lib.portalSettings(SFS);
  assert.equal(first.feedLastReadBy, "BayutBot/1.0");
  await lib.noteFeedRead(SFS, "Second/2.0");
  assert.equal((await lib.portalSettings(SFS)).feedLastReadBy, "BayutBot/1.0");
  await owner.query(`update portal_settings set feed_last_read_at = now() - interval '2 minutes' where organization_id = $1`, [SFS]);
  await lib.noteFeedRead(SFS, "x".repeat(300));
  assert.equal((await lib.portalSettings(SFS)).feedLastReadBy.length, 200);
});

test("11. the ORN and an agent's BRN are set, and cleared, in their own business only", db, async () => {
  await lib.setPortalOrn(SFS, "54321");
  assert.equal((await lib.portalSettings(SFS)).orn, "54321");
  await lib.setPortalOrn(OTHER, "11111");
  assert.equal((await lib.portalSettings(OTHER)).orn, "11111");
  assert.equal((await lib.portalSettings(SFS)).orn, "54321");
  assert.equal(await lib.setEmployeeBrn(SFS, AISHA, null), true);
  assert.equal(await lib.setEmployeeBrn(SFS, OTHER_STAFF, "123"), false);
  assert.equal(await lib.setEmployeeBrn(SFS, AISHA, "45678"), true);
});

const updatedAt = async () =>
  (await owner.query(`select updated_at from property_units where id = $1`, [unit])).rows[0].updated_at.getTime();
const later = async (before) => {
  // updated_at is now() of the change's transaction: wait past it, then compare.
  await new Promise((r) => setTimeout(r, 15));
  return (await updatedAt()) > before;
};

test("13. photo and switch changes count as a change to the listing (final review)", db, async () => {
  let before = await updatedAt();
  const added = await lib.addUnitPhoto(SFS, unit, photo, aisha);
  assert.ok(await later(before), "adding a photo");
  before = await updatedAt();
  const ids = (await positions()).map((p) => p.id);
  await lib.orderUnitPhotos(SFS, unit, [ids.at(-1), ...ids.slice(0, -1)], aisha);
  assert.ok(await later(before), "reordering");
  before = await updatedAt();
  assert.equal(await lib.removeUnitPhoto(SFS, unit, added.id, aisha), true);
  assert.ok(await later(before), "removing a photo");
  before = await updatedAt();
  await lib.setUnitPortal(SFS, unit, "bayut", true, aisha, asAisha, TODAY);
  assert.ok(await later(before), "switching a portal");
  const by = (await owner.query(`select updated_by_employee_id from property_units where id = $1`, [unit])).rows[0];
  assert.equal(by.updated_by_employee_id, AISHA);
});

test("14. an agent who has left the staff takes their units off the portals (final review)", db, async () => {
  assert.equal((await lib.publishedListings(SFS, ["bayut", "dubizzle"], TODAY, url)).length, 1);
  await owner.query(`update employees set is_active = false where id = $1`, [AISHA]);
  try {
    assert.deepEqual(await lib.publishedListings(SFS, ["bayut", "dubizzle"], TODAY, url), []);
    await lib.setUnitPortal(SFS, unit, "dubizzle", false, aisha, asAisha, TODAY);
    assert.deepEqual(await lib.setUnitPortal(SFS, unit, "dubizzle", true, aisha, asAisha, TODAY), {
      refused: "Before it can go on the portals: an agent still on the staff.",
    });
    const b = await lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAisha });
    assert.deepEqual(b.agentsGone, [AISHA]);
  } finally {
    await owner.query(`update employees set is_active = true where id = $1`, [AISHA]);
  }
  assert.deepEqual((await lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAisha })).agentsGone, []);
});

test("12. the agents an admin gives BRNs to: this business's active staff, by name", db, async () => {
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, brn, is_active) values ($1, $3, 'PR3', 'Bilal Ahmed', null, true), ($2, $3, 'PR4', 'Gone Person', '999', false)`,
    [id(13), id(14), SFS]
  );
  assert.deepEqual(await lib.portalAgents(SFS), [
    { id: AISHA, name: "Aisha Khan", brn: "45678" },
    { id: id(13), name: "Bilal Ahmed", brn: null },
  ]);
});
