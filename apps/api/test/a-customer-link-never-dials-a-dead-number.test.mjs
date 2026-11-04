// A customer link never dials a dead number (audit, 4 Nov 2026).
//
// The public Links page, and every staff member's own referral link, were built
// from each business's display number -- and every business still points at
// +971 50 480 5436, the shared line switched off on 6 Oct. All five published
// links sent customers to a number nothing answers. A switched-off number is not
// published now, and neither is a line a person holds (a person's line is
// theirs: every customer on it lands in their business, whatever the link says);
// such a business shows "no number yet" rather than a link that fails.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const LIVE = "98989898-0000-4000-8000-000000000001";
const SWITCHED_OFF = "98989898-0000-4000-8000-000000000002";
const HELD = "98989898-0000-4000-8000-000000000003";

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
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, whatsapp_display_number, timezone)
     values ($1, 'link-live', 'Live', '980501', '880501', '+971500000501', 'Asia/Dubai'),
            ($2, 'link-off', 'Switched Off', '980502', '880502', '+971500000502', 'Asia/Dubai'),
            ($3, 'link-held', 'Held', '980503', '880503', '+971500000503', 'Asia/Dubai')`,
    [LIVE, SWITCHED_OFF, HELD]
  );
  await owner.query(`insert into retired_whatsapp_numbers (phone_number_id, display_number, reason) values ('980502', '+971500000502', 'test: switched off')`);
  await owner.query(
    `insert into employees (organization_id, employee_code, full_name, whatsapp_phone_number_id, is_active)
     values ($1, 'LNK1', 'Holds the line', '980503', true)`,
    [HELD]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(`delete from retired_whatsapp_numbers where phone_number_id = '980502'`);
    await owner.query(`delete from employees where organization_id = $1`, [HELD]);
    await owner.query(`delete from organizations where id in ($1, $2, $3)`, [LIVE, SWITCHED_OFF, HELD]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    await lib?.getPool().end();
  }
});

test("a live number is published; a switched-off one and a person's line are not", db, async () => {
  for (const [where, read] of [
    ["the public page", () => lib.getDisplayNumbers()],
    ["a staff member's link, inside their business's request", () => lib.withTenant(LIVE, () => lib.getDisplayNumbers())],
  ]) {
    const numbers = await read();
    assert.equal(numbers.get(LIVE), "+971500000501", `${where}: the live number`);
    assert.equal(numbers.has(SWITCHED_OFF), false, `${where}: a switched-off number was published`);
    assert.equal(numbers.has(HELD), false, `${where}: a person's line was published as the business's`);
  }
});
