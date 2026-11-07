// The private listing page's records (7 Nov 2026): a link shows its pocket unit
// only while every rule still holds — not revoked or expired, the unit open and
// still a pocket, ready (permit valid today), the business active — and never
// what stays private. Views are counted once per ten minutes; interest once.
//
// Database cases run against the throwaway Postgres (see the-pocket-tables).
// Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §1, §5, §6
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

const id = (n) => `11220000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const AISHA = id(11);
const R = id(21);
const N = id(22);
const SARA = id(31);
const D_SARA = id(41);
const TODAY = "2026-11-07";
const aisha = { employeeId: AISHA };
const asAisha = { employeeId: AISHA, seesAll: false };

let owner;
let dbTurn;
let lib;
let token;
let rPhoto;
let nPhoto;

const shareRow = async () => (await owner.query(`select * from unit_pocket_shares where token = $1`, [token])).rows[0];

before(async () => {
  if (db.skip) return;
  process.env.NEXUS_TOKEN_KEY = "a-test-only-token-key-of-at-least-32-chars";
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(M112);
  await owner.query(`delete from organizations where id = $1`, [SFS]);
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'pkv-sfs', 'SFS International', '911221', '811221', 'Asia/Dubai')`,
    [SFS]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, whatsapp_number, brn) values ($1, $2, 'PKV1', 'Aisha Khan', '971500000001', '45678')`,
    [AISHA, SFS]
  );
  await owner.query(`insert into portal_settings (organization_id, orn) values ($1, '12345')`, [SFS]);
  for (const [unitId, ref] of [[R, "Palm villa 12"], [N, "Palm villa 14"]]) {
    await owner.query(
      `insert into property_units (id, organization_id, step, reference, community, property_type, bedrooms, purpose, price_aed,
                                   form_a_signed_on, permit_number, permit_expires_on, agent_employee_id, title, description,
                                   size_sqft, bathrooms, furnishing, sub_community, building, amenities, notes, pocket)
       values ($1, $2, 'S9', $3, 'Palm Jumeirah', 'villa', 4, 'sale', 1000000,
               '2026-10-28', '71450', '2099-10-27', $4, 'Palm villa with beach access',
               'A four-bedroom villa on the Palm with its own stretch of beach and a private pool.',
               5200, 5, 'furnished', 'Frond K', 'Signature Villas', array['private_pool'], 'Owner wants discretion', true)`,
      [unitId, SFS, ref, AISHA]
    );
    for (let i = 0; i < 3; i++) {
      await owner.query(
        `insert into unit_photos (organization_id, unit_id, position, bytes, width, height, size) values ($1, $2, $3, '\\xffd8ff', 2048, 1536, 3)`,
        [SFS, unitId, i]
      );
    }
  }
  rPhoto = (await owner.query(`select id from unit_photos where unit_id = $1 order by position limit 1`, [R])).rows[0].id;
  nPhoto = (await owner.query(`select id from unit_photos where unit_id = $1 order by position limit 1`, [N])).rows[0].id;
  await owner.query(
    `insert into contacts (id, organization_id, wa_id, display_name, owner_employee_id) values ($1, $2, '971501112233', 'Sara Khan', $3)`,
    [SARA, SFS, AISHA]
  );
  await owner.query(`insert into property_deals (id, organization_id, contact_id, step, purpose, budget_aed) values ($1, $2, $3, 'D5', 'sale', 950000)`, [D_SARA, SFS, SARA]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  token = (await lib.createPocketShare(SFS, R, D_SARA, aisha, asAisha, TODAY)).token;
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

test("1. a fresh link shows the listing", db, async () => {
  const found = await lib.pocketShareView(token);
  assert.equal(found.organizationId, SFS);
  const v = found.view;
  assert.equal(v.businessName, "SFS International");
  assert.equal(v.recipientFirstName, "Sara");
  assert.equal(v.title, "Palm villa with beach access");
  assert.equal(v.purpose, "sale");
  assert.equal(v.priceAed, 1000000);
  assert.equal(v.propertyType, "villa");
  assert.equal(v.bedrooms, 4);
  assert.equal(v.bathrooms, 5);
  assert.equal(v.sizeSqft, 5200);
  assert.equal(v.community, "Palm Jumeirah");
  assert.equal(v.subCommunity, "Frond K");
  assert.deepEqual(v.amenities, ["private_pool"]);
  assert.equal(v.photoIds.length, 3);
  assert.deepEqual(v.agent, { name: "Aisha Khan", firstName: "Aisha", brn: "45678", whatsapp: "971500000001" });
  assert.equal(v.orn, "12345");
  assert.equal(v.permitNumber, "71450");
  assert.match(v.expiresAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("2. the page never carries what stays private", db, async () => {
  const { view } = await lib.pocketShareView(token);
  for (const k of ["building", "reference", "notes", "owner", "dealIds", "token"]) assert.ok(!(k in view), k);
  const text = JSON.stringify(view);
  for (const s of ["Signature Villas", "Palm villa 12", "Owner wants discretion", token]) assert.ok(!text.includes(s), s);
});

test("3. a refresh is not a second view", db, async () => {
  const { organizationId, shareId } = await lib.pocketShareView(token);
  await lib.notePocketView(organizationId, shareId);
  await lib.notePocketView(organizationId, shareId);
  let row = await shareRow();
  assert.equal(row.view_count, 1);
  assert.ok(row.first_viewed_at);
  await owner.query(`update unit_pocket_shares set last_viewed_at = now() - interval '11 minutes' where token = $1`, [token]);
  await lib.notePocketView(organizationId, shareId);
  row = await shareRow();
  assert.equal(row.view_count, 2);
});

test("4. a photo is served only for its own unit while the link works", db, async () => {
  const bytes = await lib.pocketPhoto(token, rPhoto);
  assert.ok(bytes && bytes.length === 3);
  assert.equal(await lib.pocketPhoto(token, nPhoto), null, "another unit's photo");
  assert.equal(await lib.pocketPhoto("short", rPhoto), null);
});

test("5. interest is recorded once, and says whom to tell", db, async () => {
  const first = await lib.recordPocketInterest(token);
  assert.deepEqual(first, { first: true, notify: AISHA, title: "Palm villa with beach access", recipientFirstName: "Sara", agentFirstName: "Aisha" });
  const again = await lib.recordPocketInterest(token);
  assert.equal(again.first, false);
  assert.ok((await shareRow()).interested_at);
});

test("6. every rule is checked on every view", db, async () => {
  const cases = [
    ["revoked", `update unit_pocket_shares set revoked_at = now() where token = '${"$T"}'`, `update unit_pocket_shares set revoked_at = null where token = '${"$T"}'`],
    ["expired", `update unit_pocket_shares set expires_at = now() - interval '1 minute' where token = '${"$T"}'`, `update unit_pocket_shares set expires_at = now() + interval '14 days' where token = '${"$T"}'`],
    ["closed", `update property_units set closed_at = now(), closed_reason = 'withdrawn' where id = '${R}'`, `update property_units set closed_at = null, closed_reason = null where id = '${R}'`],
    ["pocket off", `update property_units set pocket = false where id = '${R}'`, `update property_units set pocket = true where id = '${R}'`],
    ["permit expired", `update property_units set permit_expires_on = '2026-01-01' where id = '${R}'`, `update property_units set permit_expires_on = '2099-10-27' where id = '${R}'`],
    ["business inactive", `update organizations set is_active = false where id = '${SFS}'`, `update organizations set is_active = true where id = '${SFS}'`],
  ];
  for (const [name, doIt, undo] of cases) {
    await owner.query(doIt.replaceAll("$T", token));
    try {
      assert.equal(await lib.pocketShareView(token), null, name);
      assert.equal(await lib.pocketPhoto(token, rPhoto), null, `${name}: photo`);
      assert.equal(await lib.recordPocketInterest(token), null, `${name}: interest`);
    } finally {
      await owner.query(undo.replaceAll("$T", token));
    }
  }
  assert.ok(await lib.pocketShareView(token), "available again once every rule holds");
  assert.equal(await lib.pocketShareView("not-a-token"), null);
  assert.equal(await lib.pocketShareView("A".repeat(43)), null, "a well-formed token nobody holds");
});

test("7. an agent's number as Meta writes it still gives a WhatsApp button (final review)", db, async () => {
  await owner.query(`update employees set whatsapp_number = '+971 50 000 0001' where id = $1`, [AISHA]);
  try {
    const { view } = await lib.pocketShareView(token);
    assert.equal(view.agent.whatsapp, "971500000001");
    assert.equal(view.contact.whatsapp, "971500000001");
  } finally {
    await owner.query(`update employees set whatsapp_number = '971500000001' where id = $1`, [AISHA]);
  }
});

test("8. the buyer's own agent is their contact and hears of their interest (final review)", db, async () => {
  const BILAL = id(12);
  const OMAR = id(32);
  const D_OMAR = id(42);
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, whatsapp_number, brn) values ($1, $2, 'PKV2', 'Bilal Ahmed', '+971 50 000 0002', null)`,
    [BILAL, SFS]
  );
  await owner.query(`insert into contacts (id, organization_id, wa_id, display_name, owner_employee_id) values ($1, $2, '971502223344', 'Omar Haddad', $3)`, [OMAR, SFS, BILAL]);
  await owner.query(`insert into property_deals (id, organization_id, contact_id, step, purpose, budget_aed) values ($1, $2, $3, 'D4', 'sale', 1200000)`, [D_OMAR, SFS, OMAR]);
  // Bilal shares Aisha's listing with his own client.
  const bilalsToken = (await lib.createPocketShare(SFS, R, D_OMAR, { employeeId: BILAL }, { employeeId: BILAL, seesAll: false }, TODAY)).token;
  const { view } = await lib.pocketShareView(bilalsToken);
  assert.deepEqual(view.agent, { name: "Aisha Khan", firstName: "Aisha", brn: "45678", whatsapp: "971500000001" }, "the listing agent and licence stay");
  assert.deepEqual(view.contact, { name: "Bilal Ahmed", firstName: "Bilal", whatsapp: "971500000002" });
  const interest = await lib.recordPocketInterest(bilalsToken);
  assert.equal(interest.notify, BILAL, "the buyer's agent is told, not the listing agent");
  assert.equal(interest.agentFirstName, "Bilal");
});
