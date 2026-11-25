// The compact board's records (25 Nov 2026): the board answer names its viewer
// (so the screen can mark "Mine"), and "Hot leads not on the board" leaves out
// contacts that are not buyers — one of this business's own staff WhatsApp
// lines (on the last nine digits when both have nine, so "050 480 5436" and
// "00971 50 480 5436" are 971504805436), and a contact named after a business on
// Nexus (our own, or a sister firm). Another business's staff lines are private
// to it — by the query's own business filter, with tenant rules behind it — so a
// sister firm is caught by its name, not its numbers. A WhatsApp username id is
// not a number, and a customer with no number matches no staff line.
//
// Runs only against the throwaway Postgres (schema.sql plus every migration):
//   AUDIT_TEST_OWNER_URL=postgres://nexus:nexus@localhost:55441/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:app@localhost:55441/nexus
//
// Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §3.7, §3.8
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const id = (n) => `11250000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SFS = id(1);
const JPL = id(2);
const STAFF = id(11);
const SISTER_STAFF = id(12);
const NATIONAL_STAFF = id(13);
const DOUBLE_ZERO_STAFF = id(14);
const SHORT_STAFF = id(15);
const DESK_STAFF = id(16);
const BUYER = id(21);
const OURSELVES = id(22);
const SISTER = id(23);
const OUR_LINE = id(24);
const NATIONAL_LINE = id(25);
const DOUBLE_ZERO_LINE = id(26);
const SISTER_LINE = id(27);
const USERNAME = id(28);
const SHORT_TAIL = id(29);
const EMAIL_ONLY = id(30);
const TZ = "Asia/Dubai";

let owner;
let dbTurn;
let lib;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'cb-sfs', 'SFS International', '911251', '811251', 'Asia/Dubai'),
            ($2, 'cb-jpl', 'Juris Prime Legal', '911252', '811252', 'Asia/Dubai')`,
    [SFS, JPL]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, whatsapp_number)
     values ($1, $3, 'CB1', 'Atif', '+971 50 480 5436'), ($2, $4, 'CB2', 'Sister staff', '971500000001'),
            ($5, $3, 'CB3', 'Noor', '055 123 4567'), ($6, $3, 'CB4', 'Omar', '00971 56 765 4321'),
            ($7, $3, 'CB5', 'Sami', '765 1234'), ($8, $3, 'CB6', 'Front desk', null)`,
    [STAFF, SISTER_STAFF, SFS, JPL, NATIONAL_STAFF, DOUBLE_ZERO_STAFF, SHORT_STAFF, DESK_STAFF]
  );
  await owner.query(
    `insert into contacts (id, organization_id, wa_id, display_name, owner_employee_id) values
       ($1, $5, '971501111111', 'Real Buyer', $6),
       ($2, $5, '971502222222', 'SFS INTERNATIONAL REAL ESTATE LLC', $6),
       ($3, $5, '971503333333', 'Juris Prime Legal Consultancy & Law Firm', $6),
       ($4, $5, '971504805436', 'Atif', $6),
       ($7, $5, '971551234567', 'Noor', $6),
       ($8, $5, '971567654321', 'Omar', $6),
       ($9, $5, '971500000001', 'Buyer on a sister line', $6),
       ($10, $5, 'AE.13491208655504805436', 'Username buyer', $6),
       ($11, $5, '971507651234', 'Short line buyer', $6)`,
    [BUYER, OURSELVES, SISTER, OUR_LINE, SFS, STAFF, NATIONAL_LINE, DOUBLE_ZERO_LINE, SISTER_LINE, USERNAME, SHORT_TAIL]
  );
  // An email customer has no WhatsApp id at all.
  await owner.query(
    `insert into contacts (id, organization_id, channel, external_id, display_name, owner_employee_id)
     values ($1, $2, 'email', 'buyer@example.com', 'Email buyer', $3)`,
    [EMAIL_ONLY, SFS, STAFF]
  );
  for (const contact of [BUYER, OURSELVES, SISTER, OUR_LINE, NATIONAL_LINE, DOUBLE_ZERO_LINE, SISTER_LINE, USERNAME, SHORT_TAIL, EMAIL_ONLY]) {
    await owner.query(
      `insert into lead_assessments (organization_id, contact_id, score, priority, category) values ($1, $2, 90, 'high', 'buyer')`,
      [SFS, contact]
    );
  }
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from lead_assessments where organization_id in ($1, $2)`, [SFS, JPL]);
  await owner.query(`delete from organizations where id in ($1, $2)`, [SFS, JPL]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const board = (viewer) => lib.getBoard({ organizationId: SFS, timezone: TZ, viewer });

const asStaff = { employeeId: STAFF, seesAll: false };
const hotNames = (b) => b.hotWaiting.map((h) => h.name).sort();
// The buyers among the hot leads; every other contact is one of our own lines or a business on Nexus.
const BUYERS = ["Buyer on a sister line", "Email buyer", "Real Buyer", "Short line buyer", "Username buyer"];

test("hot leads leave out our own staff lines and businesses on Nexus", db, async () => {
  assert.deepEqual(hotNames(await board(asStaff)), BUYERS);
});

test("a staff line typed in national or 00 form still leaves that line out", db, async () => {
  const names = hotNames(await board(asStaff));
  assert.ok(!names.includes("Noor"), `055 123 4567 is 971551234567: ${names.join(", ")}`);
  assert.ok(!names.includes("Omar"), `00971 56 765 4321 is 971567654321: ${names.join(", ")}`);
});

test("another business's staff lines leave out nobody, even read across every business", db, async () => {
  // Read as the table owner or a cross-business job would: row-level security no longer
  // narrows employees to SFS here, so only the query itself keeps Juris Prime's staff out.
  const across = hotNames(await lib.withAllTenants("test: the board read across every business", () => board(asStaff)));
  assert.ok(across.includes("Buyer on a sister line"), across.join(", "));
  assert.deepEqual(across, hotNames(await board(asStaff)));
});

test("a WhatsApp username customer is never matched on the digits of their username id", db, async () => {
  // AE.13491208655504805436 ends in 504805436, the last nine digits of Atif's line.
  assert.ok(hotNames(await board(asStaff)).includes("Username buyer"));
});

test("a staff number shorter than nine digits leaves out only that exact number", db, async () => {
  // "765 1234" is the tail of 971507651234, but seven digits are too few to call it the same line.
  assert.ok(hotNames(await board(asStaff)).includes("Short line buyer"));
});

test("a customer with no WhatsApp number is never taken for a staff line", db, async () => {
  // The front desk has no number and the email buyer no WhatsApp id; two blanks are not one line.
  assert.ok(hotNames(await board(asStaff)).includes("Email buyer"));
});

test("the board names its viewer", db, async () => {
  assert.deepEqual((await board({ employeeId: STAFF, seesAll: false })).viewer, { employeeId: STAFF, seesAll: false });
  assert.deepEqual((await board({ employeeId: null, seesAll: true })).viewer, { employeeId: null, seesAll: true });
});
