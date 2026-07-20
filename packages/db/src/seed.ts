import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getPool } from "./client.js";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", "..", "..", ".env") }); // monorepo root .env, regardless of cwd
const sql = readFileSync(join(here, "..", "seed.sql"), "utf8");

async function main() {
  const pool = getPool();
  await pool.query(sql);
  await pool.end();
  console.log("Seed data inserted.");
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
