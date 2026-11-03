// Bulk sends from the admins' own numbers only (3 Nov 2026). The owner: "make
// only for admin who can do the bulk message — Atif and Ralph Ivan for now".
// Staff campaigns were retired on 30 Oct; Bulk is admin-only; now its "Send
// from" list offers a number only when the record holding it is an admin's —
// their seat, or a staff record linked to their admin account.
//
// The database case runs against the throwaway Postgres, seeded as the owner,
// acting as `nexus_app` through @nexus/db:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55436/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55436/nexus
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "b0a10000-0000-4000-8000-000000000001";
const ADMIN = "b0a10a00-0000-4000-8000-00000000000a";
const LINKED = "e0a10000-0000-4000-8000-000000000001"; // an admin's own staff record
const STAFF = "e0a10000-0000-4000-8000-000000000002"; // ordinary staff with a number

let owner;
let dbTurn;
let lib;
let bulk;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'bulk-admins', 'Bulk Admins', '980001', '880001', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(`insert into retired_whatsapp_numbers (phone_number_id, display_number, reason) values ('980001', null, 'test: shared line off')`);
  await owner.query(`insert into admins (id, email, full_name, password_hash) values ($1, 'bulk-admin@example.com', 'Bulk Admin', 'x')`, [ADMIN]);
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email, whatsapp_phone_number_id, whatsapp_number, admin_id)
     values ($1, $3, 'BA1', 'Bulk Admin', 'bulk-admin@zipicka.example', '980011', '+971 50 000 8011', $4),
            ($2, $3, 'BA2', 'Ordinary Staff', 'staff@zipicka.example', '980012', '+971 50 000 8012', null)`,
    [LINKED, STAFF, ORG, ADMIN]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  bulk = await import("../src/routes/admin-bulk.ts");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from retired_whatsapp_numbers where phone_number_id = '980001'`);
  await owner.query(`delete from organizations where id = $1`, [ORG]);
  await owner.query(`delete from admins where id = $1`, [ADMIN]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const ctx = { req: { param: () => "bulk-admins" } };

test("Bulk offers an admin's own number, and no ordinary staff member's", { skip: db.skip }, async () => {
  const resolved = await lib.withAllTenants("test", () => bulk.resolve(ctx, null));
  assert.deepEqual(
    resolved.numbers.map((n) => [n.phoneNumberId, n.label]),
    [["980011", "Bulk Admin · +971 50 000 8011"]]
  );
});

test("a staff member's number cannot be chosen to send from", { skip: db.skip }, async () => {
  const resolved = await lib.withAllTenants("test", () => bulk.resolve(ctx, "980012"));
  assert.deepEqual(resolved, { error: "That number is not one of this business's connected numbers.", status: 422 });
});
