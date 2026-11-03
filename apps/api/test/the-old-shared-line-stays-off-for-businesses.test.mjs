// The old shared line, connected by a person (final review, 3 Nov 2026).
//
// Every business still points at +971 50 480 5436, switched off on 6 Oct. When
// an admin connects it through their seat it becomes THEIR line — and stays
// switched off as every business's line: no business campaign, old chat,
// assignment alert or staff member without a number may send from it. The
// person replies from it in their own chats, and can reconnect it.
//
// The source checks always run. The database cases run against the throwaway
// Postgres, seeded as the owner, acting as `nexus_app` through @nexus/db:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55436/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55436/nexus
//
// Spec: docs/superpowers/specs/2026-11-03-admin-connections-design.md §3
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = (...p) => readFileSync(join(here, "..", "src", ...p), "utf8");

test("delivery receipts ask who holds the line before which business owns it", () => {
  const processor = src("queue", "processor.ts");
  const at = processor.indexOf("const organizationId =\n    (await find");
  assert.ok(at > 0, "the receipt lookup is where it was");
  const lookup = processor.slice(at, at + 260);
  assert.ok(
    lookup.indexOf("findEmployeeByPhoneNumberId(phoneNumberId)") < lookup.indexOf("findOrganizationByPhoneNumberId(phoneNumberId)"),
    "person first, like inbound"
  );
});

test("a message on an admin's own line reaches the admin's devices", async () => {
  const { decideRecipients } = await import("../src/services/push-rules.ts");
  const staff = [
    { employeeId: "seat1", active: true, onShift: false, adminId: "adm1" },
    { employeeId: "e2", active: true, onShift: true, adminId: null },
  ];
  const base = { direction: "inbound", kind: "message", newAssigneeEmployeeId: null, staff, ownerSubjects: ["o:adm1", "o:adm2"] };
  const toSeat = decideRecipients({ ...base, assigneeEmployeeId: "seat1" });
  assert.deepEqual(toSeat, [{ subjects: ["e:seat1", "o:adm1"], requiresMode: "mine" }]);
  const toStaff = decideRecipients({ ...base, assigneeEmployeeId: "e2" });
  assert.deepEqual(toStaff, [{ subjects: ["e:e2"], requiresMode: "mine" }], "staff unchanged");
  assert.match(src("services", "push-dispatcher.ts"), /adminId: employee\.adminId \?\? null/);
});

test("only a seat made for an admin is off the rota; an adopted hire keeps their place", async () => {
  const { isCreatedSeat } = await import("@nexus/db");
  const adminId = "a5ea7a00-0000-4000-8000-00000000000a";
  assert.equal(isCreatedSeat({ adminId, employeeCode: "admin-a5ea7a00" }), true);
  assert.equal(isCreatedSeat({ adminId, employeeCode: "ATIF" }), false, "a working hire, linked");
  assert.equal(isCreatedSeat({ adminId: null, employeeCode: "admin-a5ea7a00" }), false);
  assert.match(src("services", "availability.ts"), /employee\.isActive && employee\.twinEnabled && !isCreatedSeat\(employee\)/);
});

test("no Team door gives a person any business's live line", () => {
  const employees = src("routes", "employees.ts");
  const patch = employees.slice(employees.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/whatsapp-number"'));
  assert.match(patch.slice(0, 3000), /const shared = await sharedLineRefusal\(phoneNumberId\);/);
  const own = employees.slice(employees.indexOf("async function ownDedicatedNumber("));
  assert.match(own.slice(0, 1200), /const shared = await sharedLineRefusal\(phoneNumberId\);/);
});

// ---------------------------------------------------------------------------
// Against a real Postgres: the motivating flow, end to end
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const A = "a01d0000-0000-4000-8000-00000000000a";
const B = "a01d0000-0000-4000-8000-00000000000b";
const SEAT = "e01d0000-0000-4000-8000-000000000001";
const LINE = "960001"; // the old shared line, switched off
const OTHER_LINE = "960099"; // a staff member's old line, switched off
const CA = "c01d0000-0000-4000-8000-00000000000a";
const CB = "c01d0000-0000-4000-8000-00000000000b";
const CONV_SEAT = "f01d0000-0000-4000-8000-000000000001"; // on the admin's line
const CONV_OLD_B = "f01d0000-0000-4000-8000-000000000002"; // an old shared-line chat in B

let owner;
let dbTurn;
let lib;
let connect;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'oldline-a', 'Old Line A', $3, '860001', 'Asia/Dubai'),
            ($2, 'oldline-b', 'Old Line B', $3, '860001', 'Asia/Dubai')`,
    [A, B, LINE]
  );
  await owner.query(
    `insert into retired_whatsapp_numbers (phone_number_id, display_number, reason)
     values ($1, '+971 50 000 6001', 'test: the shared line switched off'),
            ($2, '+971 50 000 6099', 'test: a staff line switched off')`,
    [LINE, OTHER_LINE]
  );
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'admin-a01d0000', 'Seat')`, [SEAT, A]);
  await owner.query(
    `insert into contacts (id, organization_id, wa_id, display_name) values ($1, $3, '971509600001', 'Seat customer'), ($2, $4, '971509600002', 'Old B customer')`,
    [CA, CB, A, B]
  );
  await owner.query(
    `insert into conversations (id, organization_id, contact_id, phone_number_id) values ($1, $3, $4, $6), ($2, $5, $7, null)`,
    [CONV_SEAT, CONV_OLD_B, A, CA, B, LINE, CB]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  connect = await import("../src/services/whatsapp-connect.ts");
  await lib.withTenant(A, () =>
    lib.assignEmployeeWhatsAppNumber(SEAT, { phoneNumberId: LINE, displayNumber: "+971 50 000 6001", verifiedName: "Old Line" })
  );
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from retired_whatsapp_numbers where phone_number_id in ($1, $2)`, [LINE, OTHER_LINE]);
  await owner.query(`delete from organizations where id in ($1, $2)`, [A, B]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

test("a person taking the old shared line leaves it switched off as every business's line", { skip: db.skip }, async () => {
  assert.equal(await lib.isWhatsAppNumberRetired(LINE), true);
  assert.equal((await lib.findEmployeeByPhoneNumberId(LINE))?.id, SEAT, "it is the person's line");
});

test("the person replies from their line; an old chat in another business does not", { skip: db.skip }, async () => {
  assert.equal((await lib.findConversationById(CONV_SEAT))?.phoneNumberId, LINE);
  assert.equal((await lib.findConversationById(CONV_OLD_B))?.phoneNumberId, null);
});

test("the person can connect the line again", { skip: db.skip }, async () => {
  assert.equal(await connect.sharedLineRefusal(LINE), null);
});

test("a staff member's own switched-off line comes back to life when given out, as before", { skip: db.skip }, async () => {
  await lib.withTenant(A, () =>
    lib.assignEmployeeWhatsAppNumber(SEAT, { phoneNumberId: OTHER_LINE, displayNumber: "+971 50 000 6099", verifiedName: "Staff" })
  );
  assert.equal(await lib.isWhatsAppNumberRetired(OTHER_LINE), false);
});
