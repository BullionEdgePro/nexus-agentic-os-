// Tenant context — step 3 of the RLS sequence (ARCHITECTURE-ABOS.md §2.2).
//
// The failure this guards against is the nastiest shape in the whole system: a
// Row-Level Security policy with no tenant context does not raise, it returns
// zero rows. Every caller reads that as "this business has no conversations".
// So the assertion has to live in application code, in front of the database,
// and it has to be loud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const CLIENT = read("packages", "db", "src", "client.ts");
const CONTEXT = read("packages", "db", "src", "tenant-context.ts");
const MIDDLEWARE = read("apps", "api", "src", "middleware", "tenant-context.ts");
const API_INDEX = read("apps", "api", "src", "index.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const RLS = read("packages", "db", "migrations", "018-row-level-security.sql");
const MESSAGES = read("packages", "db", "src", "messages.ts");

// ============================================================
// Context reaches every query without call sites opting in
// ============================================================

test("queries route to the context's client, not to an arbitrary pooled one", () => {
  // SET LOCAL applies to one connection for the life of one transaction. A
  // query that lands on a different pooled connection sees no context at all —
  // and once RLS is on, silently returns nothing.
  assert.match(CLIENT, /const context = getTenantContext\(\);\s*\n\s*if \(context\) return context\.client\.query/);
});

test("a tenant context is a real transaction, committed or rolled back", () => {
  assert.match(CLIENT, /await client\.query\("begin"\)/);
  assert.match(CLIENT, /await client\.query\("commit"\)/);
  assert.match(CLIENT, /await client\.query\("rollback"\)\.catch/);
  // Release must happen whatever the outcome, or the pool leaks a connection
  // per failed request until it is exhausted.
  assert.match(CLIENT, /finally \{\s*\n\s*client\.release\(\);/);
});

test("SET LOCAL is transaction-scoped, so context cannot leak between requests", () => {
  // set_config's third argument is is_local. Passing false would set it for the
  // whole session — and pooled connections are reused, so the next request on
  // that connection would inherit another business's tenant id.
  assert.match(CLIENT, /set_config\('app\.current_org', \$1, true\)/);
  assert.ok(
    !/set_config\('app\.current_org', \$1, false\)/.test(CLIENT),
    "session-scoped context would leak across pooled requests"
  );
});

test("nesting keeps the outermost scope authoritative", () => {
  // An inner withAllTenants inside an outer withTenant would silently widen the
  // scope — the exact leak this whole mechanism exists to prevent.
  assert.match(CLIENT, /const existing = getTenantContext\(\);\s*\n(\s*\/\/[^\n]*\n)*\s*if \(existing\) return fn\(\);/);
});

// ============================================================
// A missing context is loud, never silent
// ============================================================

test("an empty organizationId is refused rather than set", () => {
  // An empty string satisfies "a context was set" while matching no rows —
  // the silent-empty-result failure, one layer up from the database.
  assert.match(CLIENT, /if \(!organizationId\)[\s\S]{0,200}throw new Error\("withTenant requires an organizationId"\)/);
});

test("the assertion names the tenant-scoped tables it guards", () => {
  for (const table of ["contacts", "conversations", "messages", "employees", "lead_assessments"]) {
    assert.ok(CLIENT.includes(`"${table}"`), `${table} must be guarded`);
  }
});

test("table matching is word-bounded and ignores comments and literals", () => {
  // Without scrubbing, a query whose comment mentions "messages" would throw.
  // Without word bounds, "messages" would match "message_templates" and
  // "broadcasts" would match "broadcast_recipients".
  assert.match(CLIENT, /function scrubSql/);
  assert.match(CLIENT, /\[\^a-z0-9_\]/);
});

test("strict mode throws; warn is only for the migration period", () => {
  assert.match(CLIENT, /if \(mode === "strict"\) throw new Error\(message\)/);
  assert.match(CLIENT, /return "warn";/);
  // The message must tell the reader what to do, and warn them what changes
  // once RLS is on — otherwise the log line is noise.
  assert.match(CLIENT, /withTenant\(organizationId/);
  assert.match(CLIENT, /returns zero rows instead of an error/);
});

test("a cross-tenant scope must state why", () => {
  assert.match(CLIENT, /if \(!reason\) throw new Error\("withAllTenants requires a reason"\)/);
  assert.match(CONTEXT, /scope: "all"; reason: string/);
});

// ============================================================
// Both legitimate cross-tenant paths are named, not assumed
// ============================================================

test("every API request runs inside some context", () => {
  assert.match(API_INDEX, /app\.use\("\/api\/\*", tenantContext\)/);
  // After the authorisation middleware: who may reach what is settled before
  // which rows come back.
  assert.ok(
    API_INDEX.indexOf('app.use("/api/*", requireAuth)') < API_INDEX.indexOf('app.use("/api/*", tenantContext)'),
    "context must be established after authentication, not before"
  );
});

test("an org-addressed request narrows to that org", () => {
  assert.match(MIDDLEWARE, /const slug = c\.req\.param\("slug"\)/);
  assert.match(MIDDLEWARE, /return withTenant\(organization\.id, \(\) => next\(\)\)/);
});

test("an unknown slug stays a 404, not a 500", () => {
  // Throwing in the middleware would collapse "no such business" into "something
  // broke", and the route below already answers that case properly.
  assert.match(MIDDLEWARE, /if \(organization\) \{/);
});

test("the webhook narrows to its tenant as soon as the lookup answers", () => {
  // The first attempt wrapped the entire job cross-tenant, on the reasoning
  // that a WhatsApp message identifies its tenant only by phone number id.
  // True of the lookup, false of everything after it — and everything after it
  // is the largest body of tenant-scoped code in the system, which is exactly
  // where a forgotten WHERE clause would leak one business's customer into
  // another's. The registry lookup needs no scope at all (organizations is not
  // tenant data), and the pipeline below it runs scoped to the org it resolved.
  assert.match(PROCESSOR, /const organization = await findOrganizationByPhoneNumberId\(phoneNumberId\)/);
  assert.match(PROCESSOR, /return withTenant\(organization\.id, async \(\) => \{/);
  assert.ok(
    !/withAllTenants/.test(PROCESSOR),
    "the message pipeline must not run platform-wide once its tenant is known"
  );
});

// ============================================================
// The policies themselves
// ============================================================

test("policies allow the tenant's own rows or an explicit cross-tenant session", () => {
  assert.match(RLS, /organization_id::text = current_setting\('app\.current_org', true\)/);
  assert.match(RLS, /current_setting\('app\.tenant_scope', true\) = 'all'/);
  // with check as well as using, or a tenant could INSERT rows belonging to
  // another business even though it cannot read them.
  assert.match(RLS, /with check \(/);
});

test("current_setting is called with missing_ok, so an unset context is null", () => {
  // Without the flag an unset GUC raises, which would break the two legitimate
  // cross-tenant paths rather than protecting anything.
  assert.ok(!/current_setting\('app\.current_org'\)/.test(RLS), "missing_ok must be passed");
});

test("the migration proves it did not empty the tables", () => {
  // The whole danger of this step is a policy that silently returns nothing.
  // "No error" is not evidence; a before/after count is.
  assert.match(RLS, /rls_before/);
  assert.match(RLS, /raise exception 'Row count for % changed from % to % while enabling RLS'/);
});

test("FORCE ROW LEVEL SECURITY is deliberately not set", () => {
  // It would subject the owner to policies too, and every future migration
  // would need a tenant context to touch its own tables.
  assert.ok(!/force row level security/i.test(RLS.replace(/--[^\n]*/g, "")));
});

test("the migration says out loud that it must not ship before the assertion", () => {
  assert.match(RLS, /DB_TENANT_ASSERT=strict/);
  console.log("PASS: tenant context is implicit, asserted, and both cross-tenant paths are named");
});

test("the inbound write path is scoped and still atomic", () => {
  // It used to hand-roll begin/commit/rollback. withTenant owns that now, so
  // the atomicity must not have been lost in the conversion.
  assert.match(MESSAGES, /return withTenant\(input\.organizationId, async \(\) => \{/);
  assert.ok(!/client\.query\("begin"\)/.test(MESSAGES), "the hand-rolled transaction should be gone");
  assert.ok(!/pool\.connect\(\)/.test(MESSAGES), "it must not check out its own connection any more");
});
