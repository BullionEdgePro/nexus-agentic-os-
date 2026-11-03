// An admin has a seat in a business (3 Nov 2026): one staff record per admin per
// business, linked by admin_id, so every staff connection — WhatsApp, Gmail,
// business email, TikTok — works for an admin unchanged.
//
// The source checks always run. The database cases run only against the
// throwaway Postgres (schema.sql plus every migration), seeded as the owner
// and acting as `nexus_app` through @nexus/db:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55436/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55436/nexus
//
// Spec: docs/superpowers/specs/2026-11-03-admin-connections-design.md §1
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const MIGRATION = readFileSync(join(root, "packages", "db", "migrations", "108-an-admin-has-a-seat-in-a-business.sql"), "utf8");

test("the migration links a seat to its admin, once per business", () => {
  assert.match(MIGRATION, /alter table employees add column if not exists admin_id uuid references admins\(id\) on delete set null/);
  assert.match(MIGRATION, /create unique index if not exists \w+\s+on employees \(organization_id, admin_id\)\s+where admin_id is not null/);
  assert.match(MIGRATION, /raise exception/);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "a5ea7000-0000-4000-8000-000000000001";
const OTHER = "a5ea7000-0000-4000-8000-000000000002";
const ADMIN_A = { id: "a5ea7a00-0000-4000-8000-00000000000a", fullName: "Atif Ali Ali Said", email: "atif@example.com" };
const ADMIN_B = { id: "a5ea7b00-0000-4000-8000-00000000000b", fullName: "Second Admin", email: "second@example.com" };
const ON_TEAM = "e5ea7000-0000-4000-8000-000000000001";
const TAKEN = "e5ea7000-0000-4000-8000-000000000002";

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
  await owner.query(MIGRATION); // safe to run twice
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'seat-one', 'Seat One', '940001', '840001', 'Asia/Dubai'),
            ($2, 'seat-two', 'Seat Two', '940002', '840002', 'Asia/Dubai')`,
    [ORG, OTHER]
  );
  await owner.query(
    `insert into admins (id, email, full_name, password_hash) values ($1, $2, $3, 'x'), ($4, $5, $6, 'x')`,
    [ADMIN_A.id, ADMIN_A.email, ADMIN_A.fullName, ADMIN_B.id, ADMIN_B.email, ADMIN_B.fullName]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id in ($1, $2)`, [ORG, OTHER]);
  await owner.query(`delete from admins where id in ($1, $2)`, [ADMIN_A.id, ADMIN_B.id]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const row = async (id) =>
  (await owner.query(`select employee_code, job_title, access_code_hash, admin_id, email, full_name from employees where id = $1`, [id])).rows[0];

test("a seat is made once and found after", { skip: db.skip }, async () => {
  const first = await lib.ensureAdminSeat(ADMIN_B, ORG);
  const again = await lib.ensureAdminSeat(ADMIN_B, ORG);
  assert.equal(again.id, first.id);
  assert.equal(first.adminId, ADMIN_B.id);
  const r = await row(first.id);
  assert.equal(r.employee_code, `admin-${ADMIN_B.id.slice(0, 8)}`);
  assert.equal(r.job_title, "Admin");
  assert.equal(r.access_code_hash, null, "nobody can sign in to a seat as staff");
  assert.equal(r.full_name, ADMIN_B.fullName);
  assert.equal((await lib.findAdminSeat(ADMIN_B.id, ORG))?.id, first.id);
  assert.equal(await lib.findAdminSeat(ADMIN_B.id, OTHER), null);
});

test("an admin already on the team is linked, not duplicated", { skip: db.skip }, async () => {
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email) values ($1, $2, 'ATIF', 'Atif Ali', 'ATIF@example.com')`,
    [ON_TEAM, ORG]
  );
  const seat = await lib.ensureAdminSeat(ADMIN_A, ORG);
  assert.equal(seat.id, ON_TEAM);
  assert.equal((await row(ON_TEAM)).admin_id, ADMIN_A.id);
  const { rows } = await owner.query(`select count(*)::int as n from employees where organization_id = $1 and lower(email) = 'atif@example.com'`, [ORG]);
  assert.equal(rows[0].n, 1);
});

test("a record linked to another admin is never taken over", { skip: db.skip }, async () => {
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email, admin_id) values ($1, $2, 'TAKEN', 'Linked elsewhere', $3, $4)`,
    [TAKEN, OTHER, ADMIN_A.email, ADMIN_B.id]
  );
  const seat = await lib.ensureAdminSeat(ADMIN_A, OTHER);
  assert.notEqual(seat.id, TAKEN);
  assert.equal((await row(TAKEN)).admin_id, ADMIN_B.id);
});
