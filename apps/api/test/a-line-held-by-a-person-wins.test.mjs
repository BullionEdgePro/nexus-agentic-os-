// A line held by a person wins (3 Nov 2026). An admin may connect a number that
// is also a business's old shared line — +971 50 480 5436 was switched off on
// 6 Oct and every business still points at it. Once a person holds it,
// messages to it reach that person (not the old five-business switchboard),
// and Bulk shows it once, as theirs. A LIVE shared line is still never given to
// one person.
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
const PROCESSOR = src("queue", "processor.ts");
const CONNECT = src("services", "whatsapp-connect.ts");

/** The source of one function, up to the next top-level declaration. */
function body(source, head) {
  const at = source.indexOf(head);
  assert.ok(at >= 0, `${head} not found`);
  const rest = source.slice(at + head.length);
  const end = rest.search(/\n(?:export )?(?:async )?function /);
  return rest.slice(0, end < 0 ? undefined : end);
}

test("inbound asks who holds the line before which business owns it", () => {
  const answer = body(PROCESSOR, "async function answerOneMessage(");
  const person = answer.indexOf("findEmployeeByPhoneNumberId(phoneNumberId)");
  const business = answer.indexOf("findOrganizationByPhoneNumberId(phoneNumberId)");
  assert.ok(person > 0 && business > 0, "both lookups are made");
  assert.ok(person < business, "the person's line is checked first");
  assert.match(answer.slice(person, business), /handleStaffNumberMessage\(staffOwner, message, text, contactName\);\s*return;/);
});

test("a live shared line is refused before anything is connected", () => {
  const connect = body(CONNECT, "export async function connectWhatsAppNumber(");
  const refusal = connect.indexOf("await sharedLineRefusal(connectedPhoneNumberId)");
  assert.ok(refusal > 0, "the connect flow asks");
  assert.ok(refusal < connect.indexOf("subscribeAppToWaba("), "before Meta is told");
  assert.ok(refusal < connect.indexOf("saveConnection("), "before anything is stored");
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "a1e00000-0000-4000-8000-000000000001";

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
     values ($1, 'held-one', 'Held One', '930101', '830101', 'Asia/Dubai')`,
    [ORG]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  connect = await import("../src/services/whatsapp-connect.ts");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from retired_whatsapp_numbers where phone_number_id = '930101'`);
  await owner.query(`delete from organizations where id = $1`, [ORG]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

test("a business's live line cannot be connected to a person; a switched-off one can", { skip: db.skip }, async () => {
  assert.equal(
    await connect.sharedLineRefusal("930101"),
    "That is the shared company number — assigning it would send every customer to one person."
  );
  await owner.query(
    `insert into retired_whatsapp_numbers (phone_number_id, display_number, reason) values ('930101', '+971 50 000 0101', 'test: switched off')`
  );
  assert.equal(await connect.sharedLineRefusal("930101"), null);
  assert.equal(await connect.sharedLineRefusal("939999"), null, "a number no business owns");
});

test("Bulk does not offer the business's own number when a person — in ANY business — holds it", () => {
  const numbers = body(src("routes", "admin-bulk.ts"), "async function numbersOf(");
  // Every business still points at the old shared line; once one person holds
  // it, it is theirs alone — listed under them, and in no business as "own".
  assert.match(
    numbers,
    /if \(\s*organization\.whatsappPhoneNumberId &&\s*!\(await findEmployeeByPhoneNumberId\(organization\.whatsappPhoneNumberId\)\) &&\s*!\(await isWhatsAppNumberRetired\(organization\.whatsappPhoneNumberId\)\)\s*\)/
  );
});

test("an admin's seat is never auto-assigned customers", () => {
  // Only a seat MADE for an admin; a working hire an admin was linked to keeps
  // their place on the rota (final review, 3 Nov 2026).
  const availability = src("services", "availability.ts");
  assert.match(availability, /\(employee\) => employee\.isActive && employee\.twinEnabled && !isCreatedSeat\(employee\)/);
});
