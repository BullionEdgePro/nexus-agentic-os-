import { config } from "dotenv";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool, withAllTenants } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", "..", "..", ".env") }); // monorepo root .env, regardless of cwd

const schemaPath = join(here, "..", "schema.sql");
const migrationsDir = join(here, "..", "migrations");

/**
 * schema.sql is the fresh-install baseline and is NOT idempotent (plain
 * `create table`), so it must only run on an empty database. Everything in
 * migrations/ is written to be idempotent and safe to re-run, which is what
 * makes this command safe to point at production.
 */
async function isFreshDatabase(): Promise<boolean> {
  const { rows } = await getPool().query<{ exists: boolean }>(
    `select exists (
       select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'organizations'
     ) as exists`
  );
  return !rows[0]?.exists;
}

/**
 * A migration is deliberately cross-tenant, and has to say so.
 *
 * THIS BROKE THE MOMENT `DB_TENANT_ASSERT=strict` WENT LIVE (2026-08-13) AND
 * NOBODY FOUND OUT UNTIL THE NEXT DEPLOY. Every file here runs through
 * `getPool()`, which asserts a tenant context, and 21 of the 32 migrations
 * mention a tenant-scoped table. So the first migration attempted under strict
 * failed at file 002 with "Query touched tenant-scoped table conversations with
 * no tenant context" — a message about application code, raised by a schema
 * tool, which is exactly the wrong place to read it. Migration 031 had been
 * applied hours earlier, before strict was loaded into the containers, so
 * nothing in between reported a problem.
 *
 * The quieter half matters more. Silencing the assertion alone would not have
 * been enough: tables like `agent_configs` carry RLS policies, and an UPDATE
 * from the application role with no context satisfies no policy, so it matches
 * ZERO ROWS AND SUCCEEDS. A migration that changes nothing and exits 0 is the
 * worst outcome available here — the deploy reports success and the change is
 * simply absent, which is this platform's recurring failure shape rendered in
 * schema management.
 *
 * `withAllTenants` fixes both at once: it supplies a context, so the assertion
 * passes, and it sets `app.tenant_scope = 'all'`, so the policies let a
 * migration's writes through. The reason string is required and lands in the
 * logs, which is right — a migration IS a deliberate cross-tenant operation and
 * should be greppable as one.
 *
 * Wrapped per FILE rather than around the whole loop. `withAllTenants` opens a
 * transaction, and one transaction per file is the semantics this already had
 * (a multi-statement `query` is an implicit transaction), so a failure still
 * rolls back only the file that failed and leaves the ones before it applied.
 * Safe because no migration uses CREATE INDEX CONCURRENTLY, which is the one
 * thing that cannot run inside a transaction.
 */
async function main() {
  if (await withAllTenants("migrate: detect fresh database", () => isFreshDatabase())) {
    await withAllTenants("migrate: baseline schema", () =>
      getPool().query(readFileSync(schemaPath, "utf8"))
    );
    console.log("Baseline schema applied.");
  } else {
    console.log("Existing database detected — skipping baseline schema.");
  }

  if (existsSync(migrationsDir)) {
    // Lexical order is the migration order — files are numbered (001-, 002-).
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      await withAllTenants(`migrate: ${file}`, () =>
        getPool().query(readFileSync(join(migrationsDir, file), "utf8"))
      );
      console.log(`Applied migration: ${file}`);
    }
  }

  await getPool().end();
  console.log("Migrations complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
