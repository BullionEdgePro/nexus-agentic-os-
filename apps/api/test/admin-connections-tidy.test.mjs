// Admin connections, tidied (3 Nov 2026, the deferred minors of the final
// review): no empty "Admin" seat lingers on Team, a removed seat stops saying
// "Connected", the review sandbox is no business to connect for, a seat is not
// staff to the "nobody's job" finding, and a deploy refuses a database that
// does not match the code.
//
// The source checks always run. The database cases run against the throwaway
// Postgres, seeded as the owner, acting as `nexus_app` through @nexus/db:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55436/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55436/nexus
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const src = (...p) => readFileSync(join(here, "..", "src", ...p), "utf8");
const ROUTE = src("routes", "connections.ts");

test("a sign-in comes back to the page its person can open", async () => {
  const { returnPageFor } = await import("../src/routes/connections.ts");
  assert.equal(returnPageFor({ sub: "a", role: "operator", adminId: "x" }), "/deck/connections");
  assert.equal(returnPageFor({ sub: "s", role: "employee", employeeId: "e", organizationId: "o" }), "/deck/my-clients");
});

test("a broken staff session is told so in staff words", async () => {
  const { ownerFor } = await import("../src/routes/connections.ts");
  const ctx = { get: () => ({ sub: "s", role: "employee" }), req: { query: () => undefined } };
  assert.deepEqual(await ownerFor(ctx, { create: true }), {
    error: "Your sign-in is incomplete — sign out and sign in again.",
    status: 403,
  });
});

test("nothing makes a seat it does not need", () => {
  // Facebook and Instagram are the business's, not a person's: no seat.
  const facebook = ROUTE.slice(ROUTE.indexOf("async function startFacebookLogin("));
  assert.match(facebook.slice(0, 600), /ownerFor\(c, \{ create: false, businessLevel: true \}\)/);
  // "Not set up on this server" is said before a seat is made.
  for (const [route, check] of [['"/tiktok/start"', "tiktokConfigured()"], ['"/gmail/start"', "gmailConfigured()"]]) {
    const at = ROUTE.indexOf(`connectionsRoute.get(${route}`);
    const body = ROUTE.slice(at, at + 1500);
    assert.ok(body.indexOf(check) > 0 && body.indexOf(check) < body.indexOf("ownerFor(c, { create: true })"), route);
  }
});

test("the review sandbox is no business to connect for", () => {
  assert.match(ROUTE, /\(await listOrganizations\(\)\)\.filter\(\(o\) => o\.slug !== "review-demo"\)/);
});

test("a seat made for an admin is not staff to the 'nobody's job' finding", () => {
  const operators = src("services", "operators.ts");
  const at = operators.indexOf("An open follow-up with no owner.");
  assert.match(operators.slice(at, at + 800), /and not \(admin_id is not null and employee_code = 'admin-' \|\| left\(admin_id::text, 8\)\)/);
});

test("the Team list and the admin's Connections clear empty seats first", () => {
  // In its own savepoint: a failed clean-up must not abort the page's transaction.
  assert.match(src("routes", "employees.ts"), /await isolated\(\(\) => releaseEmptySeats\(organization\.id\)\)\.catch\(\(\) => 0\);/);
  assert.match(ROUTE, /await isolated\(\(\) => releaseEmptySeats\(chosen\.id\)\)\.catch\(\(\) => 0\);/);
});

test("a deploy refuses a database that does not match the code", () => {
  const deploy = readFileSync(join(root, "scripts", "deploy.sh"), "utf8");
  const pull = deploy.indexOf("git pull --ff-only origin main");
  const drift = deploy.indexOf("./scripts/schema-drift-check.sh");
  const build = deploy.indexOf("$COMPOSE build api worker web");
  assert.ok(pull > 0 && drift > pull && drift < build, "pull, then the drift check, then the build");
  assert.match(deploy.slice(drift, drift + 300), /\|\| \{[^}]*exit 1;?\s*\}/);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "a71d0000-0000-4000-8000-000000000001";
const ADMIN = { id: "a71d0a00-0000-4000-8000-00000000000a", fullName: "Tidy Admin", email: "tidy-admin@example.com" };
const OTHER_ADMIN = { id: "a71d0b00-0000-4000-8000-00000000000b", fullName: "Other Admin", email: "other-admin@example.com" };
const HIRE = "e71d0000-0000-4000-8000-000000000009";

let owner;
let dbTurn;
let lib;
let route;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'tidy-one', 'Tidy One', '970001', '870001', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(`insert into admins (id, email, full_name, password_hash) values ($1, $2, $3, 'x'), ($4, $5, $6, 'x')`, [
    ADMIN.id, ADMIN.email, ADMIN.fullName, OTHER_ADMIN.id, OTHER_ADMIN.email, OTHER_ADMIN.fullName,
  ]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  route = await import("../src/routes/connections.ts");
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id = $1`, [ORG]);
  await owner.query(`delete from admins where id in ($1, $2)`, [ADMIN.id, OTHER_ADMIN.id]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

const age = (id, minutes) => owner.query(`update employees set created_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes]);
const exists = async (id) => (await owner.query(`select 1 from employees where id = $1`, [id])).rowCount === 1;

test("an empty seat goes after the sign-in window; anything in use stays", { skip: db.skip }, async () => {
  const empty = await lib.ensureAdminSeat(ADMIN, ORG);
  const fresh = await lib.ensureAdminSeat(OTHER_ADMIN, ORG);
  await age(empty.id, 20);
  // A working hire linked to an admin is never a seat to clear, however old.
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name, email, admin_id, created_at)
     values ($1, $2, 'TIDYHIRE', 'Linked hire', 'hire@example.com', null, now() - interval '1 day')`,
    [HIRE, ORG]
  );
  const removed = await lib.releaseEmptySeats(ORG);
  assert.equal(removed, 1);
  assert.equal(await exists(empty.id), false, "an empty seat past the window is cleared");
  assert.equal(await exists(fresh.id), true, "a seat made a moment ago may be mid sign-in");
  assert.equal(await exists(HIRE), true, "a staff record is never a seat to clear");
});

test("a seat with something connected is never cleared", { skip: db.skip }, async () => {
  const seat = await lib.ensureAdminSeat(ADMIN, ORG);
  await age(seat.id, 60);
  await lib.withTenant(ORG, () =>
    lib.assignEmployeeWhatsAppNumber(seat.id, { phoneNumberId: "970055", displayNumber: "+971 50 000 7055", verifiedName: "Tidy" })
  );
  assert.equal(await lib.releaseEmptySeats(ORG), 0);
  assert.equal(await exists(seat.id), true);
});

test("a removed seat stops saying connected, and connecting again brings it back", { skip: db.skip }, async () => {
  const seat = await lib.findAdminSeat(ADMIN.id, ORG);
  await owner.query(`update employees set is_active = false where id = $1`, [seat.id]);
  assert.equal(await lib.findAdminSeat(ADMIN.id, ORG), null);
  const again = await lib.ensureAdminSeat(ADMIN, ORG);
  assert.equal(again.id, seat.id);
  assert.equal(again.isActive, true);
});

test("Facebook and Instagram for an admin need the business, not a seat", { skip: db.skip }, async () => {
  await owner.query(`delete from employees where admin_id = $1`, [OTHER_ADMIN.id]);
  const ctx = {
    get: () => ({ sub: OTHER_ADMIN.email, role: "operator", adminId: OTHER_ADMIN.id }),
    req: { query: (k) => (k === "business" ? "tidy-one" : undefined) },
  };
  assert.deepEqual(await route.ownerFor(ctx, { create: false, businessLevel: true }), { organizationId: ORG, employeeId: null });
  assert.equal(await lib.findAdminSeat(OTHER_ADMIN.id, ORG), null, "no seat was made");
  const sandbox = { ...ctx, req: { query: (k) => (k === "business" ? "review-demo" : undefined) } };
  assert.deepEqual(await route.ownerFor(sandbox, { create: true }), { error: "Business not found.", status: 404 });
});
