// A migration must be able to run, and must be able to change something.
//
// `npm run db:migrate` was broken in production for a day and nobody knew.
// DB_TENANT_ASSERT=strict went live on 2026-08-13; every migration file runs
// through getPool(), which asserts a tenant context; and 21 of the 32 files
// mention a tenant-scoped table. So the next deploy's migration died at
// "Query touched tenant-scoped table conversations with no tenant context" —
// an error about application code, raised by a schema tool.
//
// Nothing caught it in between because migration 031 had been applied hours
// EARLIER, before strict was loaded into the containers. The last run was green,
// the tool was broken, and the two facts had no way to meet.
//
// The quieter half is the one worth keeping a test for. Silencing the assertion
// is not enough: tenant-scoped tables carry RLS policies, so a migration UPDATE
// from the application role with no context satisfies no policy and matches
// ZERO ROWS WITHOUT ERROR. A migration that changes nothing and exits 0 lets a
// deploy report success while the change is simply absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const MIGRATE = read("packages", "db", "src", "migrate.ts");

/**
 * Comments stripped before matching on code shape.
 *
 * The first version of the test below failed on migrate.ts's own doc comment,
 * which names DB_TENANT_ASSERT while explaining why it must not be touched —
 * an assertion about what the code DOES, answered by what it SAYS. rls-preflight
 * hit exactly this and was fixed the same way; repeating it here rather than
 * rediscovering it a third time.
 */
const MIGRATE_CODE = MIGRATE.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const CLIENT = read("packages", "db", "src", "client.ts");
const migrationsDir = join(root, "packages", "db", "migrations");
const MIGRATION_FILES = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));

test("the assertion this tripped over is still armed", () => {
  // If this ever stops being true the rest of the file is testing nothing. The
  // guard is the reason migrations need a declared scope at all.
  assert.match(CLIENT, /Query touched tenant-scoped table/);
  assert.match(CLIENT, /if \(mode === "strict"\) throw new Error\(message\)/);
});

test("every migration runs inside a declared cross-tenant scope", () => {
  // withAllTenants, not withTenant: a migration belongs to no single business.
  // And not merely "no assertion" — see the next test for why the scope has to
  // be real rather than suppressed.
  assert.match(MIGRATE, /withAllTenants\(`migrate: \$\{file\}`/);
  assert.match(MIGRATE, /withAllTenants\("migrate: baseline schema"/);
  // The fresh-database probe reads information_schema, which is not tenant
  // scoped — but it runs before any wrapper existed and is cheap to protect.
  assert.match(MIGRATE, /withAllTenants\("migrate: detect fresh database"/);
});

test("a raw pool is not used to sidestep the guard", () => {
  // The tempting fix — connect around the assertion — silences the error and
  // keeps the failure. RLS would still filter the writes to nothing, and the
  // migration would exit 0 having changed nothing at all.
  assert.ok(
    !/new Pool\(|rawPool|pg["']\)/.test(MIGRATE_CODE),
    "migrate.ts must go through getPool(), so RLS scope travels with the query"
  );
  assert.ok(
    !/DB_TENANT_ASSERT/.test(MIGRATE_CODE),
    "migrate.ts must not turn the assertion off — it needs the scope, not the silence"
  );
});

test("withAllTenants really opens the scope RLS policies look for", () => {
  // The whole fix rests on this one statement. The policies test
  // `current_setting('app.tenant_scope', true) = 'all'`, so if this wrapper
  // ever stopped setting it, migrations would go back to matching zero rows —
  // silently, which is the failure being guarded.
  assert.match(CLIENT, /set_config\('app\.tenant_scope', 'all', true\)/);
});

test("no migration uses CREATE INDEX CONCURRENTLY", () => {
  // Each file now runs inside a transaction. CONCURRENTLY cannot, so adding one
  // would fail at deploy time rather than here. This is the check that makes the
  // per-file transaction decision safe to keep.
  for (const file of MIGRATION_FILES) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    assert.ok(
      !/concurrently/i.test(sql),
      `${file} uses CONCURRENTLY, which cannot run inside the transaction migrations now use`
    );
  }
});

test("it refuses to start as a role that cannot run DDL", () => {
  // The second wall, hit immediately after the first was cleared: the api
  // container connects as `nexus_app`, which migration 006 deliberately created
  // without CREATE on schema public. That is not a bug to route around — RLS
  // does not apply to a table's owner, so the application MUST be a non-owner or
  // every policy in migration 018 quietly stops enforcing.
  //
  // So the runner has to fail on the FIRST query rather than thirty lines into a
  // Postgres stack trace at file 001, and it has to name the role and the fix.
  assert.match(MIGRATE_CODE, /has_schema_privilege\(current_user, 'public', 'CREATE'\)/);
  assert.match(MIGRATE_CODE, /assertCanMigrate/);
  assert.match(MIGRATE, /MIGRATION_DATABASE_URL to owner credentials/);
  // Preflight runs before anything is applied, so nothing is half-migrated when
  // the problem is discovered.
  const main = MIGRATE.slice(MIGRATE.indexOf("async function main()"));
  assert.ok(
    main.indexOf("assertCanMigrate") < main.indexOf("isFreshDatabase"),
    "the privilege check must run before any migration work"
  );
});

test("the owner connection is chosen before the pool is built", () => {
  // The pool is lazy, so MIGRATION_DATABASE_URL only takes effect if it is
  // assigned before the first query. Assigned after, it would be ignored in
  // silence and migrations would run as the app role again.
  assert.ok(
    MIGRATE.indexOf("MIGRATION_DATABASE_URL") < MIGRATE.indexOf("async function main()"),
    "the connection override must be applied at module load, before any query"
  );
});

test("a failure stops the run rather than reporting success", () => {
  // The loop awaits each file, and main() has no try/catch swallowing it, so a
  // throw propagates to the handler that exits non-zero. A migration runner that
  // logged and continued would apply file 032 on a database where 031 failed.
  assert.match(MIGRATE, /main\(\)\.catch\(\(err\) => \{[\s\S]*process\.exit\(1\)/);
  assert.ok(
    !/catch[\s\S]{0,80}console\.(warn|log)[\s\S]{0,40}continue/.test(MIGRATE),
    "a migration failure must not be logged and skipped"
  );
  console.log(`PASS: ${MIGRATION_FILES.length} migrations can run and can change something`);
});
