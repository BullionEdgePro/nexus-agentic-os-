// An admin connects like staff (3 Nov 2026): Connections resolves an admin to
// their seat in the business they pick (?business=<slug>), so the staff code
// path runs unchanged. Staff are unchanged.
//
// The source checks always run. The database cases run against the throwaway
// Postgres, seeded as the owner, acting as `nexus_app` through @nexus/db:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55436/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55436/nexus
//
// Spec: docs/superpowers/specs/2026-11-03-admin-connections-design.md §2
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = readFileSync(join(here, "..", "src", "routes", "connections.ts"), "utf8");

test("every connections route asks one place whose account it is", () => {
  assert.match(ROUTE, /export async function ownerFor\(/);
  assert.doesNotMatch(ROUTE, /\bownerOf\(/);
  // Starting a connection makes the admin's seat — TikTok, Facebook/Instagram,
  // Gmail, the business mailbox, WhatsApp; reading, importing history or
  // removing never does.
  assert.equal((ROUTE.match(/ownerFor\(c, \{ create: true \}\)/g) ?? []).length, 5);
  assert.ok((ROUTE.match(/ownerFor\(c, \{ create: false \}\)/g) ?? []).length >= 8);
});

test("a sign-in for an admin's seat comes back to Connections", () => {
  // Admins cannot open My clients; staff keep it.
  assert.match(ROUTE, /async function returnPage\(/);
  assert.match(ROUTE, /adminId \? "\/deck\/connections" : "\/deck\/my-clients"/);
  assert.equal((ROUTE.match(/const page = await returnPage\(c\);/g) ?? []).length, 3);
  assert.doesNotMatch(ROUTE, /\$\{app\}\/deck\/my-clients\?connected=/);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "a5ec0000-0000-4000-8000-000000000001";
const ADMIN = { id: "a5ec0a00-0000-4000-8000-00000000000a", fullName: "Connecting Admin", email: "connect-admin@example.com" };
const STAFF = "e5ec0000-0000-4000-8000-000000000001";

let owner;
let dbTurn;
let lib;
let route;
let app;
let scope;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'cnx-one', 'Connect One', '950001', '850001', 'Asia/Dubai')`,
    [ORG]
  );
  await owner.query(`insert into admins (id, email, full_name, password_hash) values ($1, $2, $3, 'x')`, [
    ADMIN.id,
    ADMIN.email,
    ADMIN.fullName,
  ]);
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'CNX1', 'Staff One')`, [
    STAFF,
    ORG,
  ]);
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
  route = await import("../src/routes/connections.ts");
  const { Hono } = await import("hono");
  const { tenantContext } = await import("../src/middleware/tenant-context.ts");
  app = new Hono();
  app.use("*", async (c, next) => {
    c.set("scope", scope);
    await next();
  });
  app.use("/api/*", tenantContext);
  app.route("/api/connections", route.connectionsRoute);
});

after(async () => {
  if (db.skip) return;
  await owner.query(`delete from organizations where id = $1`, [ORG]);
  await owner.query(`delete from admins where id = $1`, [ADMIN.id]);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  await lib.getPool().end();
});

/** The smallest context ownerFor reads: the session and the query string. */
const ctx = (s, query = {}) => ({ get: (k) => (k === "scope" ? s : undefined), req: { query: (k) => query[k] } });
const asAdmin = { sub: ADMIN.email, role: "operator", adminId: ADMIN.id };

test("staff resolve to themselves, unchanged", { skip: db.skip }, async () => {
  const staff = { sub: "Staff One", role: "employee", employeeId: STAFF, organizationId: ORG };
  assert.deepEqual(await route.ownerFor(ctx(staff), { create: true }), { organizationId: ORG, employeeId: STAFF });
});

test("an admin with no business, or an unknown one, is told so", { skip: db.skip }, async () => {
  assert.deepEqual(await route.ownerFor(ctx(asAdmin), { create: true }), {
    error: "Choose which business to connect for.",
    status: 400,
  });
  assert.deepEqual(await route.ownerFor(ctx(asAdmin, { business: "no-such-firm" }), { create: true }), {
    error: "Business not found.",
    status: 404,
  });
  const anonymous = await route.ownerFor(ctx({ sub: "old-password", role: "operator" }, { business: "cnx-one" }), { create: true });
  assert.equal(anonymous.status, 403);
});

test("an admin reading never makes a seat; connecting does, once", { skip: db.skip }, async () => {
  const before = await route.ownerFor(ctx(asAdmin, { business: "cnx-one" }), { create: false });
  assert.deepEqual(before, { error: "Nothing is connected for this business yet.", status: 404 });
  assert.equal(await lib.findAdminSeat(ADMIN.id, ORG), null, "a look made no seat");

  const made = await route.ownerFor(ctx(asAdmin, { business: "cnx-one" }), { create: true });
  const seat = await lib.findAdminSeat(ADMIN.id, ORG);
  assert.deepEqual(made, { organizationId: ORG, employeeId: seat.id });
  assert.deepEqual(await route.ownerFor(ctx(asAdmin, { business: "cnx-one" }), { create: false }), made);
});

test("the admin's listing names the businesses; staff's does not", { skip: db.skip }, async () => {
  scope = asAdmin;
  const none = await (await app.request("/api/connections")).json();
  assert.equal(none.business, null);
  assert.deepEqual(none.connections, []);
  assert.ok(none.businesses.some((b) => b.slug === "cnx-one" && b.name === "Connect One"));
  assert.ok(Array.isArray(none.providers) && none.providers.some((p) => p.id === "whatsapp"));

  const chosen = await (await app.request("/api/connections?business=cnx-one")).json();
  assert.equal(chosen.business, "cnx-one");
  assert.deepEqual(chosen.connections, []);

  // A stale choice (a business that no longer exists) reads as no choice.
  const stale = await (await app.request("/api/connections?business=gone")).json();
  assert.equal(stale.business, null);

  scope = { sub: "Staff One", role: "employee", employeeId: STAFF, organizationId: ORG };
  const staff = await (await app.request("/api/connections")).json();
  assert.equal(staff.businesses, undefined);
  assert.deepEqual(staff.connections, []);
});
