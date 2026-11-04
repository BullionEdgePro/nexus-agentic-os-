// A check across businesses sees every business (audit, 4 Nov 2026).
//
// Some questions are about everyone on purpose: has this person said STOP to
// ANY of our businesses (the test send, Bulk's "+ Add numbers")? Does ANYONE,
// in any business, hold this number (Bulk's number list, the connect flow's
// refusal to hand out a live line)? They ask through withAllTenants. But since
// 3 Nov every API request runs as its business, and a withAllTenants nested in
// that request quietly kept the request's one-business view -- so each of those
// checks answered for one business while saying "everyone".
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ELSEWHERE = "97979797-0000-4000-8000-000000000001";
const ASKING = "97979797-0000-4000-8000-000000000002";
const HOLDER = "97979797-0000-4000-8000-0000000000e1";

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
     values ($1, 'across-elsewhere', 'Elsewhere', '970401', '870401', 'Asia/Dubai'),
            ($2, 'across-asking', 'Asking', '970402', '870402', 'Asia/Dubai')`,
    [ELSEWHERE, ASKING]
  );
  await owner.query(
    `insert into contacts (organization_id, wa_id, channel, display_name, reengagement_opted_out)
     values ($1, '971598000401', 'whatsapp', 'Said stop elsewhere', true)`,
    [ELSEWHERE]
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, whatsapp_phone_number_id, is_active)
     values ($1, $2, 'ACR1', 'Holds a line elsewhere', '970499', true)`,
    [HOLDER, ELSEWHERE]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(`delete from employees where organization_id = $1`, [ELSEWHERE]);
    await owner.query(`delete from contacts where organization_id in ($1, $2)`, [ELSEWHERE, ASKING]);
    await owner.query(`delete from organizations where id in ($1, $2)`, [ELSEWHERE, ASKING]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    await lib?.getPool().end();
  }
});

test("asked inside another business's request, a STOP anywhere still counts", db, async () => {
  assert.equal(await lib.isWaIdOptedOut("971598000401"), true, "outside any request");
  assert.equal(
    await lib.withTenant(ASKING, () => lib.isWaIdOptedOut("971598000401")),
    true,
    "inside a request for another business, the STOP was not seen"
  );
});

test("asked inside another business's request, a line held anywhere is still found", db, async () => {
  const held = await lib.withTenant(ASKING, () => lib.findEmployeeByPhoneNumberId("970499"));
  assert.equal(held?.id, HOLDER, "inside a request for another business, the holder was not seen");
});

test("and the request's own view is back to its business afterwards", db, async () => {
  const seen = await lib.withTenant(ASKING, async () => {
    await lib.isWaIdOptedOut("971598000401");
    const { rows } = await lib.getPool().query(`select count(*)::int as n from contacts where organization_id = $1`, [ELSEWHERE]);
    return rows[0].n;
  });
  assert.equal(seen, 0, "the widened view leaked into the rest of the request");
});
