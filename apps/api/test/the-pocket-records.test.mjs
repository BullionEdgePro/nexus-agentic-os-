// Pocket listing records (7 Nov 2026): the Pocket switch keeps a unit off every
// portal; a pocket unit is shared one buyer at a time, only when it would be
// ready for the portals, only with a buyer this viewer can see; the board
// carries the pocket and its shares but never a link's token.
//
// Database cases run against the throwaway Postgres (see the-pocket-tables).
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §2, §4, §7
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const M112 = readFileSync(join(root, "packages", "db", "migrations", "112-a-unit-kept-off-market.sql"), "utf8");

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11210000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const AISHA = id(11);
const BILAL = id(12);
const R = id(21); // ready, will be a pocket listing
const N = id(22); // ready, never a pocket
const U = id(23); // a pocket unit not ready (S5)
const C = id(24); // a closed unit
const SARA = id(31); // Aisha's client
const OMAR = id(32); // Bilal's client
const RENTER = id(33); // Aisha's client, renting
const D_SARA = id(41);
const D_OMAR = id(42);
const D_RENT = id(43);
const TZ = "Asia/Dubai";
const TODAY = "2026-11-07";
const aisha = { employeeId: AISHA };
const asAisha = { employeeId: AISHA, seesAll: false };
const asAdmin = { employeeId: null, seesAll: true };
const POCKET_STAYS_OFF = "A pocket listing stays off the portals — turn Pocket off to publish it.";
const NOT_YOUR_BUYER = "That buyer is not on your board for this kind of unit.";

let owner;
let dbTurn;
let lib;

const ready = (unitId, ref) =>
  owner.query(
    `insert into property_units (id, organization_id, step, reference, community, property_type, bedrooms, purpose, price_aed,
                                 form_a_signed_on, permit_number, permit_expires_on, agent_employee_id, title, description,
                                 size_sqft, bathrooms, furnishing, sub_community, building, amenities, notes)
     values ($1, $2, 'S9', $3, 'Palm Jumeirah', 'villa', 4, 'sale', 1000000,
             '2026-10-28', '71450', '2099-10-27', $4, 'Palm villa with beach access',
             'A four-bedroom villa on the Palm with its own stretch of beach and a private pool.',
             5200, 5, 'furnished', 'Frond K', 'Signature Villas', array['private_pool'], 'Owner wants discretion')`,
    [unitId, SFS, ref, AISHA]
  );
const photos = async (unitId) => {
  for (let i = 0; i < 3; i++) {
    await owner.query(
      `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size) values ($1, $2, $3, '\\xffd8ff', 2048, 1536, 3)`,
      [SFS, unitId, i]
    );
  }
};
const portalRows = async (unitId) =>
  (await owner.query(`select portal, wanted, changed_by_employee_id from unit_portals where unit_id = $1 order by portal`, [unitId])).rows;
const shareRows = async (unitId) =>
  (await owner.query(`select id, deal_id, token, revoked_at, expires_at from unit_pocket_shares where unit_id = $1 order by created_at`, [unitId])).rows;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(M112);
  await owner.query(`delete from organizations where id = $1`, [SFS]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'pkr-sfs', 'SFS International', '911211', '811211', 'Asia/Dubai')`,
    [SFS]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, whatsapp_number, brn)
     values ($1, $3, 'PKR1', 'Aisha Khan', '971500000001', '45678'), ($2, $3, 'PKR2', 'Bilal Ahmed', null, '45679')`,
    [AISHA, BILAL, SFS]
  );
  await owner.query(`insert into portal_settings (organization_id, orn) values ($1, '12345')`, [SFS]);
  await ready(R, "Palm villa 12");
  await photos(R);
  await ready(N, "Palm villa 14");
  await photos(N);
  await owner.query(`insert into property_units (id, organization_id, step, reference, pocket) values ($1, $2, 'S5', 'Bay Square · 1', true)`, [U, SFS]);
  await owner.query(
    `insert into property_units (id, organization_id, step, reference, closed_at, closed_reason) values ($1, $2, 'S5', 'Closed · 1', now(), 'withdrawn')`,
    [C, SFS]
  );
  await owner.query(
    `insert into contacts (id, organization_id, wa_id, display_name, owner_employee_id) values
       ($1, $4, '971501112233', 'Sara Khan', $5), ($2, $4, '971502223344', 'Omar Haddad', $6), ($3, $4, '971503334455', 'Rana Ali', $5)`,
    [SARA, OMAR, RENTER, SFS, AISHA, BILAL]
  );
  await owner.query(
    `insert into property_deals (id, organization_id, contact_id, step, purpose, budget_aed) values
       ($1, $4, $5, 'D5', 'sale', 950000), ($2, $4, $6, 'D4', 'sale', 1200000), ($3, $4, $7, 'D4', 'rent', 200000)`,
    [D_SARA, D_OMAR, D_RENT, SFS, SARA, OMAR, RENTER]
  );
  await owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, 'bayut', true), ($1, $2, 'property_finder', true)`,
    [SFS, R]
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

test("1. Pocket on turns every portal off, and says who did it", db, async () => {
  const card = await lib.setUnitPocket(SFS, R, true, aisha, asAisha);
  assert.equal(card.pocket.on, true);
  assert.ok(card.pocket.since);
  assert.deepEqual(card.pocket.shares, []);
  for (const p of ["bayut", "dubizzle", "property_finder"]) assert.equal(card.portals[p].wanted, false, p);
  const rows = await portalRows(R);
  assert.ok(rows.length >= 2);
  for (const r of rows) {
    assert.equal(r.wanted, false, r.portal);
    assert.equal(r.changed_by_employee_id, AISHA, r.portal);
  }
});

test("2. a pocket unit's switch cannot go on", db, async () => {
  assert.deepEqual(await lib.setUnitPortal(SFS, R, "bayut", true, aisha, asAisha, TODAY), { refused: POCKET_STAYS_OFF });
  const off = await lib.setUnitPortal(SFS, R, "bayut", false, aisha, asAisha, TODAY);
  assert.equal(off.portals.bayut.wanted, false, "off is always allowed");
});

test("3. the feed leaves a pocket unit out even with a switch on", db, async () => {
  await owner.query(`update unit_portals set wanted = true where unit_id = $1 and portal = 'bayut'`, [R]);
  await owner.query(`insert into unit_portals (organization_id, unit_id, portal, wanted) values ($1, $2, 'bayut', true)`, [SFS, N]);
  const listings = await lib.publishedListings(SFS, ["bayut"], TODAY, (p) => `https://x/${p}.jpg`);
  const refs = listings.map((l) => l.reference);
  assert.ok(refs.includes(N), "the ordinary unit is in the feed");
  assert.ok(!refs.includes(R), "the pocket unit is not");
  await owner.query(`update unit_portals set wanted = false where unit_id = $1 and portal = 'bayut'`, [R]);
});

test("4. a share needs Pocket on and a ready unit", db, async () => {
  assert.deepEqual(await lib.createPocketShare(SFS, N, D_SARA, aisha, asAisha, TODAY), { refused: "Turn Pocket on first." });
  const notReady = await lib.createPocketShare(SFS, U, D_SARA, aisha, asAisha, TODAY);
  assert.match(notReady.refused, /^Before it can be shared: /);
});

test("5. staff cannot share with a colleague's client, nor a renter a unit for sale", db, async () => {
  assert.deepEqual(await lib.createPocketShare(SFS, R, D_OMAR, aisha, asAisha, TODAY), { refused: NOT_YOUR_BUYER });
  assert.deepEqual(await lib.createPocketShare(SFS, R, D_RENT, aisha, asAisha, TODAY), { refused: NOT_YOUR_BUYER });
  assert.equal(await lib.createPocketShare(SFS, R, id(999), aisha, asAisha, TODAY), null, "an unknown deal");
});

test("6. a share answers its link once; sharing again answers the same one", db, async () => {
  const first = await lib.createPocketShare(SFS, R, D_SARA, aisha, asAisha, TODAY);
  assert.equal(first.created, true);
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(first.recipient, { firstName: "Sara", number: "971501112233" });
  assert.deepEqual(first.unit, { title: "Palm villa with beach access", community: "Palm Jumeirah", priceAed: 1000000 });
  assert.equal(first.agentFirstName, "Aisha");
  assert.equal(first.share.dealId, D_SARA);
  assert.equal(first.share.active, true);
  assert.equal(first.share.sharedBy, "Aisha Khan");
  const days = (Date.parse(first.share.expiresAt) - Date.parse(first.share.createdAt)) / 86_400_000;
  assert.ok(Math.abs(days - 14) < 0.01, `${days} days`);
  const again = await lib.createPocketShare(SFS, R, D_SARA, aisha, asAisha, TODAY);
  assert.equal(again.created, false);
  assert.equal(again.token, first.token);
  assert.equal((await shareRows(R)).length, 1);
});

test("7. an expired share is replaced by a new one", db, async () => {
  await owner.query(`update unit_pocket_shares set expires_at = now() - interval '1 minute' where unit_id = $1`, [R]);
  const fresh = await lib.createPocketShare(SFS, R, D_SARA, aisha, asAisha, TODAY);
  assert.equal(fresh.created, true);
  const rows = await shareRows(R);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].revoked_at, "the expired one is revoked");
  assert.equal(rows[1].token, fresh.token);
});

test("8. the board carries the pocket and the shares this viewer may see, never a token", db, async () => {
  // An owner (who sees every client) shares with Bilal's client.
  await lib.createPocketShare(SFS, R, D_OMAR, aisha, asAdmin, TODAY);
  const tokens = (await shareRows(R)).map((r) => r.token);
  const asStaff = await lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAisha });
  const unit = asStaff.units.find((u) => u.id === R);
  assert.equal(unit.pocket.on, true);
  assert.deepEqual(unit.pocket.shares.map((s) => s.contactName), ["Sara Khan", "Sara Khan"], "a colleague's client is not shown to staff");
  const active = unit.pocket.shares.filter((s) => s.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].viewCount, 0);
  const text = JSON.stringify(asStaff);
  for (const t of tokens) assert.ok(!text.includes(t), "no token on the board");
  const asOwner = await lib.getBoard({ organizationId: SFS, timezone: TZ, viewer: asAdmin });
  assert.ok(asOwner.units.find((u) => u.id === R).pocket.shares.some((s) => s.contactName === "Omar Haddad"));
});

test("9. Pocket off revokes every active share; revoking one by hand works too", db, async () => {
  const [one] = (await shareRows(R)).filter((r) => !r.revoked_at);
  assert.equal(await lib.revokePocketShare(SFS, R, one.id), true);
  assert.equal(await lib.revokePocketShare(SFS, R, id(998)), false);
  const card = await lib.setUnitPocket(SFS, R, false, aisha, asAisha);
  assert.equal(card.pocket.on, false);
  assert.ok((await shareRows(R)).every((r) => r.revoked_at), "every share revoked");
});

test("10. a closed unit answers closed, an unknown one null", db, async () => {
  assert.equal(await lib.setUnitPocket(SFS, C, true, aisha, asAisha), "closed");
  assert.equal(await lib.setUnitPocket(SFS, id(997), true, aisha, asAisha), null);
  assert.equal(await lib.createPocketShare(SFS, C, D_SARA, aisha, asAisha, TODAY), "closed");
  assert.equal(await lib.createPocketShare(SFS, id(997), D_SARA, aisha, asAisha, TODAY), null);
});
