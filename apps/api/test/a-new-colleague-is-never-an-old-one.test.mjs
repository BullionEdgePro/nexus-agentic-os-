// A new colleague is never an old one (audit, 4 Nov 2026).
//
// The Team form sends no staff code, so one was made from the name's Latin
// letters, and adding someone UPSERTED on (business, code). A second "Mohammed
// Ali" overwrote the first one's email and number (and quietly restored them if
// they had been removed), the screen said "added", and the next access code
// signed the newcomer into the original's customers. An Arabic-only name made no
// code at all and was refused. Now a made-up code is always a free one, and a
// typed code that is taken is refused in words.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "9a9a9a9a-0000-4000-8000-000000000001";

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
     values ($1, 'newcolleague-org', 'New Colleague', '9a0701', '8a0701', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(
    `insert into employees (organization_id, employee_code, full_name, is_active) values ($1, 'mohammed-ali', 'Mohammed Ali', true), ($1, 'mohammed-ali-2', 'Mohammed Ali', false)`,
    [ORG]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(`delete from employees where organization_id = $1`, [ORG]);
    await owner.query(`delete from organizations where id = $1`, [ORG]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    await lib?.getPool().end();
  }
});

test("a made-up code is a free one, even next to a removed namesake", db, async () => {
  const code = await lib.withTenant(ORG, () => lib.freeEmployeeCode(ORG, "mohammed-ali"));
  assert.equal(code, "mohammed-ali-3");
  assert.equal(await lib.withTenant(ORG, () => lib.freeEmployeeCode(ORG, "sara-khan")), "sara-khan");
});

test("the Team route never merges a new person into an existing one", () => {
  const route = readFileSync(new URL("../src/routes/employees.ts", import.meta.url), "utf8");
  const add = route.slice(route.indexOf("const fullName = typeof body.fullName"), route.indexOf("const rawWhatsApp"));
  assert.match(add, /freeEmployeeCode\(organization\.id, /);
  // Named for the business (review, 4 Nov 2026): a bare "staff" in every
  // business made code sign-in refuse it as matching more than one person.
  assert.match(add, /\|\| `\$\{organization\.slug\}-staff`/, "an Arabic-only name still gets a code, unique to the business");
  assert.match(add, /That staff code is already in use/);
});
