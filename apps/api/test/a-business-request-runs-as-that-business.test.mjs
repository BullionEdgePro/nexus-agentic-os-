// A business's API requests run as that business (3 Nov 2026).
//
// tenantContext was mounted only at /api/*, where Hono middleware never sees
// :slug, so every API request ran with tenant_scope = 'all' and row-level
// security scoped only the background workers. It is now also mounted at
// /api/organizations/:slug/* (where it sees the slug), ahead of the /api/*
// mount, which then nests inside it and keeps the business. Three operator-only
// number endpoints are declared cross-tenant, with reasons; the contact writes
// that must land as the number's owner switch to it on the same connection.
//
// Seeds as the owner role and acts as nexus_app, so row-level security does the
// work. Takes its turn at the shared test database (advisory lock 20261102).
// Spec: docs/superpowers/specs/2026-11-03-api-tenant-scope-design.md
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const INDEX = read("apps", "api", "src", "index.ts");
const MIDDLEWARE = read("apps", "api", "src", "middleware", "tenant-context.ts");

test("business requests get their tenant after the access guard and before the catch-all", () => {
  const guard = INDEX.indexOf('app.use("/api/organizations/:slug/*", requireTenantScope)');
  const scoped = INDEX.indexOf('app.use("/api/organizations/:slug/*", tenantContext)');
  const catchAll = INDEX.indexOf('app.use("/api/*", tenantContext)');
  assert.ok(guard > -1 && scoped > -1 && catchAll > -1, "all three mounts are present");
  assert.ok(guard < scoped, "who may reach the business is settled before its rows are opened");
  assert.ok(scoped < catchAll, "the business context must be opened before the cross-tenant catch-all");
});

test("the business routes that must span businesses are declared, each with its reason", async () => {
  assert.match(MIDDLEWARE, /export const CROSS_TENANT_ROUTES/);
  const { CROSS_TENANT_ROUTES, crossTenantReason } = await import("../src/middleware/tenant-context.ts");
  assert.equal(CROSS_TENANT_ROUTES.length, 3);
  for (const route of CROSS_TENANT_ROUTES) assert.ok(route.reason.length > 20, `${route.path} says why`);
  assert.ok(crossTenantReason("POST", "/employees/e1/whatsapp-connect"));
  assert.ok(crossTenantReason("PATCH", "/employees/e1/whatsapp-number"));
  assert.ok(crossTenantReason("POST", "/whatsapp-numbers/123/verify"));
  assert.equal(crossTenantReason("GET", "/employees/e1/whatsapp-connect"), null, "the method matters");
  assert.equal(crossTenantReason("GET", "/conversations"), null);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const OWNER = "81818181-0000-4000-8000-000000000001"; // owns the shared number
const SERVING = "81818181-0000-4000-8000-000000000002"; // on the same number
const THIRD = "81818181-0000-4000-8000-000000000003"; // its own number
const ORGS = [OWNER, SERVING, THIRD];
const STAFF = "e8181810-0000-4000-8000-000000000001"; // SERVING's employee
const THIRDS_CONTACT = "c8181810-0000-4000-8000-000000000001";

let owner;
let dbTurn; // this file's turn at the shared test database
let app;
let lib;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_number_owner)
     values ($1, 'ats-owner', 'Number Owner', '930001', '830001', 'Asia/Dubai', true),
            ($2, 'ats-serving', 'Serving Firm', '930001', '830001', 'Asia/Dubai', false),
            ($3, 'ats-third', 'Third Firm', '930003', '830003', 'Asia/Dubai', true)`,
    ORGS
  );
  await owner.query(
    `insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'ATS1', 'Serving Staff')`,
    [STAFF, SERVING]
  );
  await owner.query(
    `insert into contacts (id, organization_id, wa_id, channel, display_name) values ($1, $2, '971593000099', 'whatsapp', 'Third only')`,
    [THIRDS_CONTACT, THIRD]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = { ...(await import("@nexus/db")), ...(await import("@nexus/leads")) };
  const { Hono } = await import("hono");
  const { tenantContext } = await import("../src/middleware/tenant-context.ts");
  // Mounted exactly as index.ts mounts it.
  app = new Hono();
  app.use("/api/organizations/:slug/*", tenantContext);
  app.use("/api/*", tenantContext);
  const where = async (c) => {
    const { rows } = await lib.getPool().query(
      `select current_setting('app.current_org', true) as org, current_setting('app.tenant_scope', true) as scope`
    );
    return c.json(rows[0]);
  };
  app.get("/api/organizations/:slug/probe", where);
  app.post("/api/organizations/:slug/employees/:id/whatsapp-connect", where);
  app.get("/api/elsewhere/probe", where);
  app.get("/api/organizations/:slug/peek/:contactId", async (c) => {
    const { rowCount } = await lib.getPool().query(`select 1 from contacts where id = $1`, [c.req.param("contactId")]);
    return c.json({ seen: rowCount });
  });
});

after(async () => {
  if (db.skip) return;
  try {
    const list = ORGS.map((o) => `'${o}'`).join(", ");
    // Messages and scores first: their serving-business keys do not cascade.
    await owner.query(`delete from messages where organization_id in (${list}) or serving_organization_id in (${list})`);
    await owner.query(`delete from lead_assessments where organization_id in (${list}) or serving_organization_id in (${list})`);
    await owner.query(`delete from conversations where organization_id in (${list}) or routed_organization_id in (${list})`);
    await owner.query(`delete from organizations where id in (${list})`);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    if (lib) await lib.getPool().end();
  }
});

const ask = async (method, path) => (await app.request(path, { method })).json();

test("a business-scoped request runs as that business; everything else spans businesses", db, async () => {
  const scoped = await ask("GET", "/api/organizations/ats-serving/probe");
  assert.equal(scoped.org, SERVING);
  assert.notEqual(scoped.scope, "all");
  assert.equal((await ask("GET", "/api/elsewhere/probe")).scope, "all");
  // A declared route spans businesses: freeing a number from another business's employee.
  assert.equal((await ask("POST", "/api/organizations/ats-serving/employees/x/whatsapp-connect")).scope, "all");
  // An unknown slug is left to the route's 404, across businesses as before.
  assert.equal((await ask("GET", "/api/organizations/no-such-business/probe")).scope, "all");
});

test("the database keeps a business-scoped request to its own business's rows", db, async () => {
  assert.equal((await ask("GET", `/api/organizations/ats-serving/peek/${THIRDS_CONTACT}`)).seen, 0);
  assert.equal((await ask("GET", `/api/organizations/ats-third/peek/${THIRDS_CONTACT}`)).seen, 1);
});

test("a business on a shared number still adds a contact, filed under the number's owner", db, async () => {
  const first = await lib.withTenant(SERVING, () =>
    lib.ensureContactForServingBusiness({ servingOrganizationId: SERVING, waId: "971593000001", displayName: "New person" })
  );
  assert.equal(first.ownerOrganizationId, OWNER);
  assert.equal(first.created, true);
  const { rows } = await owner.query(
    `select ct.organization_id as contact_owner, c.organization_id as chat_owner, c.routed_organization_id as routed
       from conversations c join contacts ct on ct.id = c.contact_id where c.id = $1`,
    [first.conversationId]
  );
  assert.deepEqual(rows[0], { contact_owner: OWNER, chat_owner: OWNER, routed: SERVING });
  const again = await lib.withTenant(SERVING, () =>
    lib.ensureContactForServingBusiness({ servingOrganizationId: SERVING, waId: "971593000001" })
  );
  assert.deepEqual([again.contactId, again.conversationId, again.created], [first.contactId, first.conversationId, false]);
  // Outside the API, with no context at all, it writes as the owner exactly as before.
  const outside = await lib.ensureContactForServingBusiness({ servingOrganizationId: SERVING, waId: "971593000002" });
  assert.equal(outside.ownerOrganizationId, OWNER);
});

test("a business's staff still claim a shared customer and capture a scored lead", db, async () => {
  const contact = await lib.withTenant(SERVING, () =>
    lib.ensureContactForServingBusiness({ servingOrganizationId: SERVING, waId: "971593000003" })
  );
  const claimed = await lib.withTenant(SERVING, () => lib.assignContactOwnerIfUnowned(contact.contactId, STAFF));
  assert.equal(claimed.assigned, true);
  const lead = await lib.withTenant(SERVING, () =>
    lib.captureEmployeeLead({ organizationId: SERVING, employeeId: STAFF, contactWaId: "971593000004", note: "Wants to buy a villa this month, budget ready" })
  );
  const { rows } = await owner.query(`select organization_id, owner_employee_id, lead_score from contacts where id = any($1::uuid[])`, [
    [contact.contactId, lead.contactId],
  ]);
  const byId = Object.fromEntries(rows.map((r) => [r.organization_id + (r.owner_employee_id ?? ""), r]));
  assert.ok(rows.some((r) => r.owner_employee_id === STAFF), "the claim landed on the owner's row");
  const scored = (await owner.query(`select lead_score from contacts where id = $1`, [lead.contactId])).rows[0];
  assert.ok(scored.lead_score > 0, "the lead's score landed on the owner's row");
  void byId;
});

// ---- the final review's fixes ----------------------------------------------------------------

test("an import still says a shared customer is in someone else's book, when that someone is another firm's", db, async () => {
  // The holder works for the number's owner, whose staff this business cannot
  // see; the row must still come back with a reason, not silently unassigned.
  const theirs = "e8181810-0000-4000-8000-000000000002";
  await owner.query(`insert into employees (id, organization_id, employee_code, full_name) values ($1, $2, 'ATS2', 'Owner Staff')`, [theirs, OWNER]);
  const contact = await lib.withTenant(SERVING, () =>
    lib.ensureContactForServingBusiness({ servingOrganizationId: SERVING, waId: "971593000005" })
  );
  await owner.query(`update contacts set owner_employee_id = $2 where id = $1`, [contact.contactId, theirs]);
  const result = await lib.withTenant(SERVING, () => lib.assignContactOwnerIfUnowned(contact.contactId, STAFF));
  assert.equal(result.assigned, false);
  assert.equal(result.currentOwnerName, "another colleague");
});

test("a database error inside a switch to another business surfaces as itself", db, async () => {
  // The switch back runs in a transaction the error already aborted; its own
  // failure must not replace the cause in the logs and in the error a person sees.
  const shared = await lib.withTenant(SERVING, () =>
    lib.ensureContactForServingBusiness({ servingOrganizationId: SERVING, waId: "971593000006" })
  );
  const broken = () => lib.getPool().query("select * from no_such_table_here");
  await assert.rejects(lib.withTenant(SERVING, () => lib.withServingTenant(OWNER, broken)), /no_such_table_here/);
  await assert.rejects(lib.withTenant(SERVING, () => lib.withContactOwner(shared.contactId, broken)), /no_such_table_here/);
});
