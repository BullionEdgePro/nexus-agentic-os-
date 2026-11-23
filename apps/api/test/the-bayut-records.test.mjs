// Bayut records (23 Nov 2026): the business's Bayut token is kept sealed with
// what the last check said and which Bayut agency it belongs to; a token for
// another agency turns every Bayut and dubizzle switch off (nothing ticked on the
// Sandbox may go live on the real account by itself); each Nexus agent is linked
// to a Bayut user, by email or by hand; a unit is sent to Bayut only with its
// Bayut location and its agent's link; each answer is written on one portal's row
// without touching the switch; and a portal Bayut took down is switched off with
// the date, never republished on its own.
//
// Database cases run against the throwaway Postgres (see the-bayut-tables).
// Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §1, §4, §5, §6, §8, §9, §12, §13
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const SRC = readFileSync(join(root, "packages", "db", "src", "bayut-connection.ts"), "utf8");
const migration = (name) => readFileSync(join(root, "packages", "db", "migrations", name), "utf8");

function body(name) {
  const start = SRC.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} is not exported`);
  const next = SRC.indexOf("\nexport ", start + 1);
  return SRC.slice(start, next < 0 ? undefined : next);
}

test("everything runs as the business; only the list of connected businesses looks across them, once", () => {
  for (const name of [
    "saveBayutConnection", "recordBayutCheck", "clearBayutConnection", "bayutConnectionView", "bayutToken",
    "bayutAgentLinks", "linkBayutAgent", "autoLinkBayutAgents", "bayutListings", "bayutUnitsToSync",
    "recordBayutStep", "bayutTakenOff",
  ]) {
    assert.match(body(name), /withTenant\(organizationId,/, name);
    assert.doesNotMatch(body(name), /withAllTenants/, name);
  }
  assert.equal(body("bayutBusinesses").match(/withAllTenants\(/g)?.length, 1);
});

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11130000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const OTHER = id(2);
const ASLEEP = id(3); // an inactive business
const AISHA = id(11);
const BILAL = id(12);
const CYRUS = id(13); // no email: never linked automatically
const OTHER_STAFF = id(14); // Aisha's email, in another business
const [A, B, C, D, E, F, O] = [id(21), id(22), id(23), id(24), id(25), id(26), id(27)];
const TZ = "Asia/Dubai";
const TODAY = "2026-11-23";
const aisha = { employeeId: AISHA };
const asAisha = { employeeId: AISHA, seesAll: false };
const TOKEN = "bayut-sandbox-token-0000-7c3d";
const url = (photoId) => `https://api.nexusagenticos.com/portal-photos/${photoId}.jpg`;
const BAY_SQUARE = "UAE › Dubai › Business Bay › Bay Square";

let owner;
let dbTurn;
let lib;

before(async () => {
  if (db.skip) return;
  process.env.NEXUS_TOKEN_KEY = "a-test-only-token-key-of-at-least-32-chars";
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  for (const m of ["110-a-unit-goes-on-the-portals.sql", "111-a-key-for-property-finder.sql", "113-a-unit-goes-on-bayut.sql"]) {
    await owner.query(migration(m));
  }
  await owner.query(`delete from organizations where id in ($1, $2, $3)`, [SFS, OTHER, ASLEEP]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_active)
     values ($1, 'bar-sfs', 'BAR SFS', '911131', '811131', 'Asia/Dubai', true),
            ($2, 'bar-other', 'BAR Other', '911132', '811132', 'Asia/Dubai', true),
            ($3, 'bar-asleep', 'BAR Asleep', '911133', '811133', 'Asia/Dubai', false)`,
    [SFS, OTHER, ASLEEP]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email, whatsapp_number, brn) values
       ($1, $5, 'BAR1', 'Aisha Khan', 'Aisha.Khan@SFS.ae', '971501112233', '45678'),
       ($2, $5, 'BAR2', 'Bilal Ahmed', 'bilal@sfs.ae', '971501112244', '45679'),
       ($3, $5, 'BAR3', 'Cyrus Patel', null, '971501112255', '45680'),
       ($4, $6, 'BAR4', 'Other agent', 'aisha.khan@sfs.ae', null, '45681')`,
    [AISHA, BILAL, CYRUS, OTHER_STAFF, SFS, OTHER]
  );
  // A, B, C and F are ready for the portals; D and E are not. A and C have a Bayut location.
  const ready = (unit, org, agent, location, title = "Bright 1-bed with canal view") =>
    owner.query(
      `insert into property_units (id, organization_id, step, reference, community, property_type, bedrooms, purpose, price_aed,
                                   form_a_signed_on, permit_number, permit_expires_on, agent_employee_id, title, description,
                                   size_sqft, bathrooms, furnishing, sub_community, building, amenities,
                                   bayut_location_id, bayut_location_name)
       values ($1, $2, 'S9', $7, 'Business Bay', 'apartment', 1, 'rent', 95000,
               '2026-10-28', '71450', '2027-10-27', $3, $4,
               'A bright one-bedroom apartment on a high floor, with a balcony over the canal.',
               812, 2, 'unfurnished', 'Bay Square', 'Building 4', array['balcony'], $5, $6)`,
      [unit, org, agent, title, location?.id ?? null, location?.name ?? null, `Ref ${unit.slice(-2)}`]
    );
  await ready(A, SFS, AISHA, { id: 5002, name: BAY_SQUARE });
  await ready(B, SFS, BILAL, null);
  await ready(C, SFS, CYRUS, { id: 5004, name: "UAE › Dubai › Business Bay › Executive Towers" });
  await ready(F, SFS, AISHA, null);
  await ready(O, OTHER, OTHER_STAFF, { id: 5002, name: BAY_SQUARE });
  await owner.query(
    `insert into property_units (id, organization_id, step, reference) values ($1, $3, 'S5', 'D · 4'), ($2, $3, 'S5', 'E · 5')`,
    [D, E, SFS]
  );
  for (const unit of [A, B, C]) {
    await owner.query(
      `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size)
       select $1, $2, n, '\\xffd8ff', 2048, 1536, 3 from generate_series(0, 2) n`,
      [SFS, unit]
    );
  }
  await owner.query(
    `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size)
     select $1, $2, n, '\\xffd8ff', 2048, 1536, 3 from generate_series(0, 2) n`,
    [OTHER, O]
  );
  await owner.query(
    `insert into unit_portals (organization_id, unit_id, portal, wanted, changed_by_employee_id, remote_ref, remote_state, remote_fingerprint, published_at, synced_at) values
       ($1, $2, 'bayut', true, $8, 'BY-1', 'live', 'f1', '2026-11-20T08:00:00Z', '2026-11-22T08:00:00Z'),
       ($1, $2, 'dubizzle', true, $8, 'BY-1', 'pending', 'f1', '2026-11-22T08:00:00Z', '2026-11-22T08:00:00Z'),
       ($1, $2, 'property_finder', true, $8, 'PF-A', 'live', 'pa', null, '2026-11-22T08:00:00Z'),
       ($1, $3, 'bayut', true, null, 'BY-2', 'pending', 'f2', '2026-11-22T09:00:00Z', '2026-11-22T09:00:00Z'),
       ($1, $4, 'dubizzle', true, null, null, null, null, null, null),
       ($1, $5, 'bayut', false, null, 'BY-4', 'draft', 'f4', null, '2026-11-21T08:00:00Z'),
       ($1, $6, 'bayut', false, null, 'BY-5', 'unpublished', 'f5', null, '2026-11-21T08:00:00Z'),
       ($1, $6, 'property_finder', true, null, null, null, null, null, null),
       ($7, $9, 'bayut', true, null, 'BY-9', 'live', 'f9', '2026-11-20T08:00:00Z', '2026-11-22T08:00:00Z')`,
    [SFS, A, B, C, D, E, OTHER, AISHA, O]
  );
  await owner.query(`insert into portal_settings (organization_id, orn) values ($1, '12345'), ($2, '54321'), ($3, null)`, [SFS, OTHER, ASLEEP]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id in ($1, $2, $3)`, [SFS, OTHER, ASLEEP]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const raw = async (org) =>
  (
    await owner.query(
      `select orn, bayut_token_sealed, bayut_token_ending, bayut_agency_id, bayut_agency_name, bayut_checked_at, bayut_check_error
         from portal_settings where organization_id = $1`,
      [org]
    )
  ).rows[0];
const row = async (unit, portal) =>
  (await owner.query(`select * from unit_portals where unit_id = $1 and portal = $2`, [unit, portal])).rows[0];
const board = (org = SFS, viewer = asAisha) => lib.getBoard({ organizationId: org, timezone: TZ, viewer });

test("1. the database holds no plain token; only bayutToken opens it", db, async () => {
  assert.equal((await board()).bayutConnection, "none");
  assert.deepEqual(
    await lib.saveBayutConnection(SFS, { token: TOKEN, agencyId: 101, agencyName: "SFS Real Estate - Sandbox", checkError: null }),
    { accountChanged: false },
    "a first token has no account to change from"
  );
  const r = await raw(SFS);
  assert.ok(r.bayut_token_sealed && !r.bayut_token_sealed.includes(TOKEN));
  assert.equal(r.bayut_token_ending, "7c3d");
  assert.equal(r.bayut_agency_id, 101);
  assert.equal(r.bayut_agency_name, "SFS Real Estate - Sandbox");
  assert.ok(r.bayut_checked_at);
  assert.equal(r.bayut_check_error, null);
  assert.equal(r.orn, "12345", "the ORN is left alone");
  assert.deepEqual(await lib.bayutToken(SFS), { token: TOKEN, agencyId: 101 });
  assert.equal(await lib.bayutToken(OTHER), null);
});

test("2. the view never carries the token; a check is recorded", db, async () => {
  const view = await lib.bayutConnectionView(SFS);
  assert.deepEqual({ ...view, checkedAt: typeof view.checkedAt }, {
    saved: true, agencyName: "SFS Real Estate - Sandbox", tokenEnding: "7c3d", checkedAt: "string", checkError: null,
  });
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
  await lib.recordBayutCheck(SFS, "Bayut refused the token: Unauthenticated.");
  assert.equal((await lib.bayutConnectionView(SFS)).checkError, "Bayut refused the token: Unauthenticated.");
  await lib.recordBayutCheck(SFS, null);
  assert.equal((await lib.bayutConnectionView(SFS)).checkError, null);
  await lib.recordBayutCheck(OTHER, "Bayut refused the token: no");
  assert.deepEqual(await lib.bayutConnectionView(OTHER), { saved: false, agencyName: null, tokenEnding: null, checkedAt: null, checkError: null });
  assert.equal((await raw(OTHER)).bayut_checked_at, null, "a check is only recorded on a saved token");
});

test("3. the board tells a check that could not reach Bayut from a refused token", db, async () => {
  assert.equal((await board()).bayutConnection, "connected");
  await lib.recordBayutCheck(SFS, "Could not reach Bayut: HTTP 503");
  assert.equal((await board()).bayutConnection, "check-failed");
  await lib.recordBayutCheck(SFS, "Bayut refused the token: Unauthenticated.");
  assert.equal((await board()).bayutConnection, "token-refused");
  await lib.recordBayutCheck(SFS, null);
  assert.equal((await board()).bayutConnection, "connected");
  assert.equal((await board(OTHER, { employeeId: null, seesAll: true })).bayutConnection, "none");
});

test("4. only checked, unrefused tokens of active businesses are synced", db, async () => {
  await lib.saveBayutConnection(OTHER, { token: "other-token-zzzz", agencyId: 303, agencyName: "Other", checkError: "Bayut refused the token: no" });
  await lib.saveBayutConnection(ASLEEP, { token: "asleep-token-yyyy", agencyId: 404, agencyName: "Asleep", checkError: null });
  const businesses = await lib.bayutBusinesses();
  const ids = businesses.map((b) => b.organizationId);
  assert.ok(ids.includes(SFS));
  assert.ok(!ids.includes(OTHER), "a refused token is not synced");
  assert.ok(!ids.includes(ASLEEP), "an inactive business is not synced");
  assert.equal(businesses.find((b) => b.organizationId === SFS).timezone, TZ);
});

test("5. staff are linked by email, case-insensitive, without replacing a link", db, async () => {
  assert.equal(await lib.linkBayutAgent(SFS, BILAL, { bayutUserId: 9, bayutUserName: "Bilal (picked by hand)" }), true);
  const linked = await lib.autoLinkBayutAgents(SFS, [
    { id: 7, name: "Aisha K", email: "aisha.khan@sfs.ae" },
    { id: 8, name: "Bilal A", email: "BILAL@SFS.AE" },
    { id: 10, name: "No email", email: null },
  ]);
  assert.equal(linked, 1, "only Aisha: Bilal keeps the link an admin chose, Cyrus has no email");
  const links = (await lib.bayutAgentLinks(SFS)).sort((x, y) => x.bayutUserId - y.bayutUserId);
  assert.deepEqual(links, [
    { employeeId: AISHA, bayutUserId: 7, bayutUserName: "Aisha K" },
    { employeeId: BILAL, bayutUserId: 9, bayutUserName: "Bilal (picked by hand)" },
  ]);
  assert.deepEqual(await lib.bayutAgentLinks(OTHER), [], "the same email in another business is not linked");
  assert.equal(await lib.autoLinkBayutAgents(SFS, [{ id: 7, name: "Aisha K", email: "aisha.khan@sfs.ae" }]), 0);
  assert.equal(await lib.linkBayutAgent(SFS, OTHER_STAFF, { bayutUserId: 7, bayutUserName: null }), false, "another business's employee");
  assert.equal(await lib.linkBayutAgent(SFS, CYRUS, { bayutUserId: 11, bayutUserName: null }), true);
  assert.equal(await lib.linkBayutAgent(SFS, CYRUS, null), true, "an admin removes a link");
  assert.equal((await lib.bayutAgentLinks(SFS)).length, 2);
  assert.deepEqual((await board()).bayutLinked, { [AISHA]: true, [BILAL]: true, [CYRUS]: false });
});

test("6. a unit with no Bayut location or an unlinked agent is not sent to Bayut, and its switch-on is refused with the words", db, async () => {
  const listed = await lib.bayutListings(SFS, TODAY, url);
  assert.deepEqual(
    listed.map((l) => ({ unit: l.listing.reference, portals: l.portals, userId: l.userId, locationId: l.locationId })),
    [{ unit: A, portals: ["bayut", "dubizzle"], userId: 7, locationId: 5002 }],
    "B has no Bayut location; C's agent is not linked"
  );
  assert.deepEqual(await lib.setUnitPortal(SFS, B, "dubizzle", true, aisha, asAisha, TODAY), {
    refused: "Before it can go on the portals: the Bayut location.",
  });
  assert.deepEqual(await lib.setUnitPortal(SFS, C, "bayut", true, aisha, asAisha, TODAY), {
    refused: "Before it can go on the portals: the agent linked to a Bayut user.",
  });
  assert.deepEqual(await lib.setUnitPortal(SFS, F, "bayut", true, aisha, asAisha, TODAY), {
    refused: "Before it can go on the portals: 3 photos, the Bayut location.",
  }, "the portals' words first, then Bayut's, in one sentence");
  assert.equal((await lib.setUnitPortal(SFS, B, "property_finder", true, aisha, asAisha, TODAY)).portals.property_finder.wanted, true,
    "Property Finder does not need a Bayut location");

  const placed = await lib.updateUnit(SFS, aisha, asAisha, B, { bayutLocationId: 5003, bayutLocationName: BAY_SQUARE });
  assert.deepEqual(placed.bayutLocation, { id: 5003, name: BAY_SQUARE });
  const on = await lib.setUnitPortal(SFS, B, "dubizzle", true, aisha, asAisha, TODAY);
  assert.equal(on.portals.dubizzle.wanted, true);
  const again = await lib.bayutListings(SFS, TODAY, url);
  assert.deepEqual(
    again.map((l) => ({ unit: l.listing.reference, portals: l.portals, userId: l.userId, locationId: l.locationId })).sort((x, y) => x.unit.localeCompare(y.unit)),
    [
      { unit: A, portals: ["bayut", "dubizzle"], userId: 7, locationId: 5002 },
      { unit: B, portals: ["bayut", "dubizzle"], userId: 9, locationId: 5003 },
    ]
  );
  assert.deepEqual((await board()).units.find((u) => u.id === A).bayutLocation, { id: 5002, name: BAY_SQUARE });
  assert.equal((await board()).units.find((u) => u.id === F).bayutLocation, null);
});

test("7. the units to sync: wanted on Bayut or dubizzle, or still held there — a pending or draft unit no longer wanted included", db, async () => {
  const units = await lib.bayutUnitsToSync(SFS);
  assert.deepEqual(units.map((u) => u.unitId).sort(), [A, B, C, D].sort(), "E is unpublished and only wanted on Property Finder");
  assert.deepEqual(units.find((u) => u.unitId === D).remote, {
    ref: "BY-4", fingerprint: "f4", portals: { bayut: { state: "draft", publishedAt: null }, dubizzle: { state: null, publishedAt: null } },
  });
  assert.deepEqual(units.find((u) => u.unitId === A).remote, {
    ref: "BY-1",
    fingerprint: "f1",
    portals: {
      bayut: { state: "live", publishedAt: "2026-11-20T08:00:00.000Z" },
      dubizzle: { state: "pending", publishedAt: "2026-11-22T08:00:00.000Z" },
    },
  });
  assert.deepEqual(units.find((u) => u.unitId === C).remote, {
    ref: null, fingerprint: null, portals: { bayut: { state: null, publishedAt: null }, dubizzle: { state: null, publishedAt: null } },
  });
  await owner.query(`update unit_portals set wanted = false where unit_id = $1 and portal = 'bayut'`, [B]);
  await owner.query(`update unit_portals set wanted = false where unit_id = $1 and portal = 'dubizzle'`, [B]);
  assert.ok((await lib.bayutUnitsToSync(SFS)).some((u) => u.unitId === B), "a pending unit no longer wanted is still looked at");
  await owner.query(`update unit_portals set wanted = true where unit_id = $1 and portal in ('bayut', 'dubizzle')`, [B]);
  await owner.query(`update property_units set closed_at = now(), closed_reason = 'withdrawn' where id = $1`, [D]);
  assert.ok((await lib.bayutUnitsToSync(SFS)).some((u) => u.unitId === D), "a closed unit is looked at, so it comes off");
  await owner.query(`update property_units set closed_at = null, closed_reason = null where id = $1`, [D]);
  assert.deepEqual((await lib.bayutUnitsToSync(OTHER)).map((u) => u.unitId), [O]);
});

test("8. an answer is written on one portal's row without touching its switch", db, async () => {
  await lib.recordBayutStep(SFS, C, "dubizzle", { ref: "BY-3", state: "draft", message: null, fingerprint: "fc" });
  let r = await row(C, "dubizzle");
  assert.equal(r.wanted, true);
  assert.equal(r.remote_ref, "BY-3");
  assert.equal(r.remote_state, "draft");
  assert.equal(r.remote_fingerprint, "fc");
  assert.ok(r.synced_at);
  await lib.recordBayutStep(SFS, C, "dubizzle", { state: "pending", message: null, publishedAt: new Date("2026-11-23T08:00:00Z") });
  await lib.recordBayutStep(SFS, C, "dubizzle", { state: "refused", message: "Bayut did not accept the permit.", permitComment: "Permit number does not match the unit" });
  r = await row(C, "dubizzle");
  assert.equal(r.remote_ref, "BY-3", "no ref given keeps the ref");
  assert.equal(r.remote_fingerprint, "fc", "no fingerprint given keeps it");
  assert.equal(r.published_at.toISOString(), "2026-11-23T08:00:00.000Z", "no publish time given keeps it");
  assert.equal(r.remote_state, "refused");
  assert.equal(r.remote_message, "Bayut did not accept the permit.");
  assert.equal(r.permit_comment, "Permit number does not match the unit");
  await lib.recordBayutStep(SFS, C, "dubizzle", { state: "failed", message: "Bayut answered HTTP 503." });
  assert.equal((await row(C, "dubizzle")).permit_comment, "Permit number does not match the unit", "no permit comment given keeps it");
  const card = (await board()).units.find((u) => u.id === C);
  assert.deepEqual({ ...card.portals.dubizzle, syncedAt: typeof card.portals.dubizzle.syncedAt }, {
    wanted: true, state: "failed", message: "Bayut answered HTTP 503.", syncedAt: "string",
    permitComment: "Permit number does not match the unit", publishedAt: "2026-11-23T08:00:00.000Z",
  });
  await lib.recordBayutStep(SFS, C, "dubizzle", { state: "live", message: null, permitComment: null });
  assert.equal((await row(C, "dubizzle")).permit_comment, null, "a null permit comment clears it");
  await lib.recordBayutStep(SFS, C, "bayut", { ref: "BY-3", state: "draft", message: null, fingerprint: "fc" });
  r = await row(C, "bayut");
  assert.equal(r.wanted, false, "a unit with no Bayut row gets one, switched off");
  assert.equal(r.remote_ref, "BY-3");
});

test("9. taken off by Bayut turns the switch off with the date; the other portal is untouched", db, async () => {
  await lib.bayutTakenOff(SFS, A, "bayut", "21 Nov");
  const r = await row(A, "bayut");
  assert.equal(r.wanted, false);
  assert.equal(r.changed_by_employee_id, null, "changed by the system");
  assert.equal(r.changed_by_admin_id, null);
  assert.ok(Date.now() - r.changed_at.getTime() < 60_000);
  assert.equal(r.remote_state, "unpublished");
  assert.equal(r.remote_message, "Bayut took it off on 21 Nov");
  assert.equal(r.remote_ref, "BY-1", "the ref is kept");
  const other = await row(A, "dubizzle");
  assert.equal(other.wanted, true);
  assert.equal(other.remote_state, "pending");
  const card = (await board()).units.find((u) => u.id === A);
  assert.equal(card.portals.bayut.message, "Bayut took it off on 21 Nov");
});

test("10. the same account keeps everything; a check that failed keeps the account", db, async () => {
  const before = await owner.query(`select unit_id, portal, wanted, remote_ref, remote_state from unit_portals where organization_id = $1 order by unit_id, portal`, [SFS]);
  assert.deepEqual(
    await lib.saveBayutConnection(SFS, { token: "a-second-sandbox-token-1111", agencyId: 101, agencyName: "SFS Real Estate - Sandbox", checkError: null }),
    { accountChanged: false }
  );
  assert.deepEqual(
    await lib.saveBayutConnection(SFS, { token: "a-third-token-2222", agencyId: null, agencyName: null, checkError: "Could not reach Bayut: HTTP 503" }),
    { accountChanged: false }
  );
  const r = await raw(SFS);
  assert.equal(r.bayut_agency_id, 101, "an unknown agency keeps the one held");
  assert.equal(r.bayut_agency_name, "SFS Real Estate - Sandbox");
  assert.equal(r.bayut_token_ending, "2222");
  assert.equal(r.bayut_check_error, "Could not reach Bayut: HTTP 503");
  const after = await owner.query(`select unit_id, portal, wanted, remote_ref, remote_state from unit_portals where organization_id = $1 order by unit_id, portal`, [SFS]);
  assert.deepEqual(after.rows, before.rows);
  assert.equal((await lib.bayutAgentLinks(SFS)).length, 2, "the links are kept");
  await lib.saveBayutConnection(SFS, { token: TOKEN, agencyId: 101, agencyName: "SFS Real Estate - Sandbox", checkError: null });
});

test("11. another account turns every Bayut and dubizzle switch off and clears what Bayut said; Property Finder is untouched", db, async () => {
  assert.deepEqual(
    await lib.saveBayutConnection(SFS, { token: "the-real-account-token-9f9f", agencyId: 202, agencyName: "SFS Real Estate", checkError: null }),
    { accountChanged: true }
  );
  const rows = (
    await owner.query(
      `select unit_id, portal, wanted, changed_by_employee_id, remote_ref, remote_state, remote_message, remote_fingerprint, published_at, permit_comment, synced_at
         from unit_portals where organization_id = $1 and portal in ('bayut', 'dubizzle')`,
      [SFS]
    )
  ).rows;
  assert.ok(rows.length >= 6);
  for (const r of rows) {
    const { unit_id, portal, ...rest } = r;
    assert.deepEqual(rest, {
      wanted: false, changed_by_employee_id: null, remote_ref: null, remote_state: null, remote_message: null,
      remote_fingerprint: null, published_at: null, permit_comment: null, synced_at: null,
    }, `${unit_id} ${portal}`);
  }
  const pf = await row(A, "property_finder");
  assert.equal(pf.wanted, true);
  assert.equal(pf.remote_ref, "PF-A");
  assert.deepEqual(await lib.bayutAgentLinks(SFS), [], "the old account's users mean nothing on the new one");
  const o = await row(O, "bayut");
  assert.equal(o.wanted, true, "another business is untouched");
  assert.equal(o.remote_ref, "BY-9");
  assert.equal((await lib.bayutConnectionView(SFS)).agencyName, "SFS Real Estate");
  assert.deepEqual(await lib.bayutToken(SFS), { token: "the-real-account-token-9f9f", agencyId: 202 });
});

test("12. a disconnect clears the token and the links, leaves the units, and remembers the account", db, async () => {
  await lib.linkBayutAgent(SFS, AISHA, { bayutUserId: 70, bayutUserName: "Aisha K" });
  await lib.recordBayutStep(SFS, A, "dubizzle", { ref: "BY-21", state: "live", message: null, fingerprint: "g1" });
  await lib.clearBayutConnection(SFS);
  const r = await raw(SFS);
  for (const c of ["bayut_token_sealed", "bayut_token_ending", "bayut_checked_at", "bayut_check_error"]) assert.equal(r[c], null, c);
  assert.equal(r.orn, "12345");
  assert.equal(await lib.bayutToken(SFS), null);
  assert.deepEqual(await lib.bayutConnectionView(SFS), { saved: false, agencyName: null, tokenEnding: null, checkedAt: null, checkError: null });
  assert.deepEqual(await lib.bayutAgentLinks(SFS), []);
  assert.equal((await row(A, "dubizzle")).remote_ref, "BY-21", "listings already on Bayut stay");
  assert.equal((await board()).bayutConnection, "none");
  assert.ok(!(await lib.bayutBusinesses()).some((b) => b.organizationId === SFS));
  // Without a token the card waits for the connection instead of asking for the agent's link.
  assert.equal((await lib.setUnitPortal(SFS, C, "bayut", true, aisha, asAisha, TODAY)).portals.bayut.wanted, true);
  assert.deepEqual(
    await lib.saveBayutConnection(SFS, { token: "yet-another-account-5555", agencyId: 505, agencyName: "Elsewhere", checkError: null }),
    { accountChanged: true },
    "coming back with another account after a disconnect still starts afresh"
  );
  assert.equal((await row(A, "dubizzle")).remote_ref, null);
});
