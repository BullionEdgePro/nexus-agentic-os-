// A business knows what it owns (Business HQ, spec 2026-10-14-business-hq-design.md §6).
// Six tables: the profile, keywords, social accounts, vault entries, the reveal
// log and the automatic check results. Every one is tenant data behind RLS, read
// only through named cross-tenant reasons by the admin-only API, and the vault's
// listing never so much as selects the sealed password.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("packages", "db", "migrations", "097-a-business-knows-what-it-owns.sql");
const HQ = read("packages", "db", "src", "hq.ts");
const INDEX = read("packages", "db", "src", "index.ts");

const TABLES = ["hq_profiles", "hq_keywords", "hq_social_accounts", "hq_vault_entries", "hq_vault_reveals", "hq_checks"];

test("six tables, each behind row-level security with the tenant policy", () => {
  for (const t of TABLES) {
    assert.match(MIGRATION, new RegExp(`create table if not exists ${t} \\(`), `${t} is created`);
    assert.match(MIGRATION, new RegExp(`alter table ${t} enable row level security`), `${t} has RLS`);
    assert.match(MIGRATION, new RegExp(`create policy ${t}_tenant_isolation on ${t}`), `${t} has the tenant policy`);
  }
  assert.match(MIGRATION, /current_setting\('app\.tenant_scope', true\) = 'all'/);
});

test("the vault stores a sealed password, its age, and never forgets who looked", () => {
  assert.match(MIGRATION, /secret_enc\s+text/);
  assert.match(MIGRATION, /secret_changed_at\s+timestamptz/);
  assert.match(MIGRATION, /deleted_at\s+timestamptz/);
  assert.match(MIGRATION, /ip\s+text/);
  assert.match(MIGRATION, /user_agent\s+text/);
});

test("listing the vault never selects the sealed password", () => {
  const at = HQ.indexOf("export async function listVaultEntries(");
  assert.ok(at > -1);
  const body = HQ.slice(at, HQ.indexOf("\n}\n", at));
  assert.ok(!body.includes("secret_enc"), "the listing does not read secret_enc");
});

test("every read and write names its cross-tenant reason", () => {
  const fns = [...HQ.matchAll(/export async function (\w+)\(/g)].map((m) => m[1]);
  assert.ok(fns.length >= 14, `expected the full module, found ${fns.length}`);
  for (const name of fns) {
    const at = HQ.indexOf(`export async function ${name}(`);
    const body = HQ.slice(at, HQ.indexOf("\n}\n", at));
    assert.match(body, /withAllTenants\("business hq: /, `${name} names its reason`);
  }
  assert.match(INDEX, /export \* from "\.\/hq\.js";/);
});

// FINAL REVIEW, Important 5: a tenant table is protected under strict mode only
// when it is on TENANT_SCOPED_TABLES; off the list an unwrapped query on the
// vault would silently read zero rows instead of throwing.
test("all six Business HQ tables are on the strict tenant list", () => {
  const CLIENT = read("packages", "db", "src", "client.ts");
  for (const t of TABLES) assert.match(CLIENT, new RegExp(`"${t}"`), `${t} is tenant-scoped`);
});
