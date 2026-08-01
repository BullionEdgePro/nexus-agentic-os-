import { config } from "dotenv";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool } from "./client.js";

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

async function main() {
  const pool = getPool();

  if (await isFreshDatabase()) {
    await pool.query(readFileSync(schemaPath, "utf8"));
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
      await pool.query(readFileSync(join(migrationsDir, file), "utf8"));
      console.log(`Applied migration: ${file}`);
    }
  }

  await pool.end();
  console.log("Migrations complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
