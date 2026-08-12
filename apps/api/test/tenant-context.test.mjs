// Tenant context — step 3 of the RLS sequence (ARCHITECTURE-ABOS.md §2.2).
//
// The failure this guards against is the nastiest shape in the whole system: a
// Row-Level Security policy with no tenant context does not raise, it returns
// zero rows. Every caller reads that as "this business has no conversations".
// So the assertion has to live in application code, in front of the database,
// and it has to be loud.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
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
  // `await` rather than `return`: the memory write is deferred until after the
  // transaction closes, so the function must resume once the block is done.
  assert.match(PROCESSOR, /await withTenant\(organization\.id, async \(\) => \{/);
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

// ============================================================
// The evidence gate for step 4
// ============================================================

const PREFLIGHT = read("apps", "api", "src", "scripts", "rls-preflight.ts");

test("the preflight runs strict, and sets it before anything reads it", () => {
  // assertMode() is consulted per query, but the import graph pulls in modules
  // that may capture config at load. Setting it above the imports removes the
  // question entirely.
  assert.match(PREFLIGHT, /process\.env\.DB_TENANT_ASSERT = "strict";/);
  assert.ok(
    PREFLIGHT.indexOf('DB_TENANT_ASSERT = "strict"') < PREFLIGHT.indexOf('from "@nexus/db"'),
    "strict mode must be set before the db package is imported"
  );
});

test("it checks both directions, not just the happy one", () => {
  // A preflight that only proves "wrapped calls are silent" passes just as
  // happily when the assertion is switched off. The unwrapped half is what
  // makes the wrapped half mean anything.
  assert.match(PREFLIGHT, /must be silent/);
  assert.match(PREFLIGHT, /must refuse/);
  assert.match(PREFLIGHT, /NO ASSERTION — this table is not guarded/);
  assert.match(PREFLIGHT, /a test that cannot\s*\n?\s*\*\s*fail is not evidence/);
});

test("it distinguishes a fired assertion from an unrelated error", () => {
  // Otherwise a typo in a query reads as "not covered by a context" and sends
  // someone to fix the middleware instead of the query.
  assert.match(PREFLIGHT, /const ASSERTION = \/no tenant context\/i/);
  assert.match(PREFLIGHT, /ASSERTION FIRED — not covered by any context/);
});

test("cross-tenant and unscoped paths are declared, not inferred", () => {
  // If the preflight guessed which paths were allowed to span tenants, it would
  // be guessing about exactly the thing under test.
  assert.match(PREFLIGHT, /crossTenant\?: boolean/);
  assert.match(PREFLIGHT, /unscoped\?: boolean/);
  assert.match(PREFLIGHT, /registry, pooled aggregates/);
});

test("it refuses to bless the migration on failure", () => {
  assert.match(PREFLIGHT, /do NOT apply migration 018/);
  // The message now names both failure shapes, because they differ: an
  // unscoped read comes back empty, an unscoped write is rejected outright.
  assert.match(PREFLIGHT, /Unscoped reads return zero rows; unscoped WRITES are rejected/);
  assert.match(PREFLIGHT, /process\.exit\(allOk \? 0 : 1\)/);
  console.log("PASS: the RLS gate proves both that contexts cover the app and that the guard is live");
});

test("the preflight checks writers, not only readers", () => {
  // The gap that cost a regression. Reads degrade to an empty result under RLS;
  // WRITES are rejected outright — "new row violates row-level security
  // policy". So enabling policies silently broke every writer that does not
  // pass through the API middleware: the site crawler and the half-hourly
  // template sync both stopped writing, and the sync's only symptom would have
  // been template approvals that never arrived.
  //
  // Found by running the crawler by hand. Nothing automated would have.
  assert.match(PREFLIGHT, /Writers outside the API/);
  assert.match(PREFLIGHT, /NO CONTEXT — writes \$\{directTable\} directly, REJECTED/);
  // And the case it cannot prove is reported rather than failed — see the
  // comment on writesTenantSqlDirectly for why that distinction matters.
  assert.match(PREFLIGHT, /delegates its writes — confirm the callee scopes them/);

  // The writers are now DISCOVERED rather than listed, so this no longer
  // asserts that three names appear in the file. The hand-maintained list was
  // itself the next bug: `self-check.ts` writes an employee, a contact and a
  // lead on every run, was never on it, and had been aborting under RLS for as
  // long as the policies had been enabled. A list only contains what somebody
  // remembered.
  assert.match(PREFLIGHT, /const WRITER_DIRECTORIES = \["src\/scripts", "src\/services"\]/);
  assert.match(PREFLIGHT, /readdirSync\(join\(root, directory\)\)/);
  // Detected by what a file DOES, both in raw SQL and through the db helpers —
  // self-check writes mostly through createEmployee and captureEmployeeLead.
  assert.match(PREFLIGHT, /WRITES_SQL/);
  assert.match(PREFLIGHT, /WRITES_VIA_HELPER/);
  // Comments stripped before matching: this repo discusses writes at length in
  // prose, and matching that would flag every well-commented file and bury the
  // real ones.
  assert.match(PREFLIGHT, /const code = source\s*\n\s*\.replace/);
  // Imports stripped too: `@nexus/employees` is a package whose name is also a
  // tenant table, and matching it made create-admin.ts — which touches only the
  // admin registry — look like it wrote customer data.
  assert.match(PREFLIGHT, /\.replace\(\/\^\\s\*import/);
});

test("every writer outside the API actually establishes a context", () => {
  // Runs the same discovery the preflight runs, over the real tree, so a new
  // unscoped writer fails the suite the day it lands — without anyone adding it
  // to a list here either.
  //
  // Only PROVABLE cases fail: raw SQL against a tenant-scoped table with no
  // context in the same file, where nothing else could be establishing one.
  // A file writing solely through helpers may have its context in the callee
  // (provision-templates does, via syncTemplatesForOrganization), and reading
  // one file cannot see that. Failing those would fail correct code and make
  // the gate untrustworthy — worse than the list it replaced.
  const roots = ["scripts", "services"];
  const skip = new Set(["rls-preflight.ts", "rls-verify.ts"]);
  const TENANT_TABLES = [
    "contacts", "conversations", "messages", "employees", "lead_assessments",
    "knowledge_sources", "knowledge_chunks", "message_templates", "broadcasts",
    "agent_configs", "ai_message_evaluations", "conversation_metrics",
    "contact_memory", "tasks", "operator_findings",
  ];

  let proven = 0;
  for (const dir of roots) {
    for (const entry of readdirSync(join(here, "..", "src", dir)).filter((f) => f.endsWith(".ts"))) {
      if (skip.has(entry)) continue;
      const code = readFileSync(join(here, "..", "src", dir, entry), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ")
        .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?/gm, " ");

      const table = TENANT_TABLES.find((t) =>
        new RegExp(`(insert\\s+into|delete\\s+from|update)\\s+${t}\\b`, "i").test(code)
      );
      if (!table) continue;
      proven++;
      assert.match(
        code,
        /withTenant\(|withAllTenants\(/,
        `${dir}/${entry} writes ${table} directly with no tenant context — REJECTED under RLS`
      );
    }
  }
  // A discovery pass that finds nothing looks identical to one that found
  // everything in order. self-check.ts is in here because its cleanup runs
  // `delete from contacts` directly — which is how this caught it.
  assert.ok(proven >= 2, `expected direct tenant writers, found ${proven}`);
  console.log(`PASS: ${proven} direct tenant writer(s) outside the API establish their own context`);
});
