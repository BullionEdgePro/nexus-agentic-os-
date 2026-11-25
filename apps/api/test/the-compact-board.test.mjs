// The compact board's records (25 Nov 2026): the board answer names its viewer
// (so the screen can mark "Mine"), and "Hot leads not on the board" leaves out
// contacts that are not buyers — one of this business's own staff WhatsApp
// lines, and a contact named after a business on Nexus (our own, or a sister
// firm). Another business's staff lines are private to it (tenant rules), so a
// sister firm is caught by its name, not its numbers.
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
const BUYER = id(21);
const OURSELVES = id(22);
const SISTER = id(23);
const OUR_LINE = id(24);
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
     values ($1, $3, 'CB1', 'Atif', '+971 50 480 5436'), ($2, $4, 'CB2', 'Sister staff', '971500000001')`,
    [STAFF, SISTER_STAFF, SFS, JPL]
  );
  await owner.query(
    `insert into contacts (id, organization_id, wa_id, display_name, owner_employee_id) values
       ($1, $5, '971501111111', 'Real Buyer', $6),
       ($2, $5, '971502222222', 'SFS INTERNATIONAL REAL ESTATE LLC', $6),
       ($3, $5, '971503333333', 'Juris Prime Legal Consultancy & Law Firm', $6),
       ($4, $5, '971504805436', 'Atif', $6)`,
    [BUYER, OURSELVES, SISTER, OUR_LINE, SFS, STAFF]
  );
  for (const contact of [BUYER, OURSELVES, SISTER, OUR_LINE]) {
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

test("hot leads leave out our own staff lines and businesses on Nexus", db, async () => {
  const b = await board({ employeeId: STAFF, seesAll: false });
  assert.deepEqual(b.hotWaiting.map((h) => h.name), ["Real Buyer"]);
});

test("the board names its viewer", db, async () => {
  assert.deepEqual((await board({ employeeId: STAFF, seesAll: false })).viewer, { employeeId: STAFF, seesAll: false });
  assert.deepEqual((await board({ employeeId: null, seesAll: true })).viewer, { employeeId: null, seesAll: true });
});
