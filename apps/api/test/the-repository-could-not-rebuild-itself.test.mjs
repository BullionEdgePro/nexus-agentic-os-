// The repository could not rebuild its own database, and four tenant tables had
// no row-level security.
//
// Both were found the same way on 2026-08-19: by building the schema this
// repository describes in a throwaway database -- schema.sql, then all 51
// migrations in order -- and diffing it against production. That is now
// `scripts/schema-drift-check.sh`.
//
// WHAT THE REPLAY FOUND FIRST. `npm run migrate` against an empty database
// fails at file 010 of 51. Migration 010 refuses to run when zipicka has no
// whatsapp_phone_number_id, which is right, but `select ... into` leaves the
// variable null when there is no zipicka row AT ALL -- and on a fresh database
// there is not. Four more migrations assert the shape of seeded rows the same
// way. The documented fresh-install path has never worked; nobody found out
// because nobody has installed this from scratch since the seed and the
// migrations diverged.
//
// WHAT THE DIFF FOUND ONCE THE REPLAY GOT TO THE END. Production carried an RLS
// policy on `contact_memory` that no migration creates -- migration 018 names
// the table in its array but runs BEFORE 021 creates it, so production is
// protected only because the runner re-applies every file on every deploy and
// 018 eventually caught up. A fresh install runs each file once, in order, and
// never would.
//
// Pulling that thread: four tables have an organization_id and no policy at
// all. `agent_quality_daily` holds 195 rows across all five businesses. The set
// is typed out in THREE places -- 018's array, TENANT_SCOPED_TABLES, and
// rls-verify's own copy -- and a table is protected only if it is in all three.
// These were in none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const MIGRATIONS = join(root, "packages", "db", "migrations");
const CLIENT = read("packages", "db", "src", "client.ts");
const RLS_VERIFY = read("apps", "api", "src", "scripts", "rls-verify.ts");

test("every data assertion skips an empty database", () => {
  // A migration that asserts the shape of SEEDED rows must not fire before the
  // seed exists, or it makes a fresh install impossible. Each of these was
  // found by the replay, in order, one run at a time.
  const guarded = [
    "010-enable-shared-number.sql",
    "012-agent-prompts.sql",
    "014-abr-replaces-atif-ali.sql",
    "023-arabic-routing-keywords.sql",
    "024-resolve-keyword-collisions.sql",
  ];
  for (const file of guarded) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    assert.ok(
      /if not exists \(select 1 from organizations\) then/.test(sql) ||
        /if not found then/.test(sql),
      `${file} must skip its data check when there are no organizations`
    );
  }
});

test("the schema assertions are left alone", () => {
  // The other half of the same rule. A migration asserting that a COLUMN or an
  // INDEX exists is correct on an empty database and must keep firing there --
  // guarding those would turn a real check into a no-op on exactly the database
  // where it matters most.
  const sql = readFileSync(join(MIGRATIONS, "013-employee-sourced-leads.sql"), "utf8");
  assert.match(sql, /raise exception 'Migration 013 incomplete/);
  assert.ok(
    !/if not exists \(select 1 from organizations\) then/.test(sql),
    "013 asserts columns, not seeded rows -- it must not be guarded"
  );
});

test("row-level security is derived from the schema, not typed out again", () => {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  const last = files[files.length - 1];
  const sql = readFileSync(join(MIGRATIONS, "052-rls-for-every-tenant-table.sql"), "utf8");

  // Derived: it finds its own tables by looking for the column, so a table
  // added after it is covered by re-running rather than by remembering.
  assert.match(sql, /column_name = 'organization_id'/);
  assert.match(sql, /alter table %I enable row level security/);

  // And it asserts, which is what makes it a check rather than a best effort.
  assert.match(sql, /Tenant tables still without row-level security/);

  // It must stay the LAST migration, or tables created after it go unprotected
  // again -- the exact way 018 stopped covering contact_memory.
  assert.equal(last, "052-rls-for-every-tenant-table.sql",
    "a migration was added after 052; move the derived RLS pass to the end");
});

test("the three hand-maintained lists agree about the four tables", () => {
  for (const table of [
    "agent_quality_daily",
    "employee_presence_events",
    "organization_users",
    "twin_handbacks",
  ]) {
    assert.ok(
      CLIENT.includes(`${JSON.stringify(table)},`),
      `${table} has an organization_id and must be in TENANT_SCOPED_TABLES`
    );
  }
});

test("rls-verify can find a table nobody listed", () => {
  // The gate passed for as long as those four existed, correctly, about the
  // tables it had been told about. A check whose scope is a list can only ever
  // confirm the list.
  assert.match(RLS_VERIFY, /rls-verify: derived catalog/);
  assert.match(RLS_VERIFY, /not c\.relrowsecurity/);
  assert.match(RLS_VERIFY, /has organization_id and NO row-level security/);
});

test("the quality route reads inside a tenant context", () => {
  // Both handlers read `agent_quality_daily`, which had no policy, so they were
  // held correct by an explicit WHERE clause and nothing else. Enabling the
  // policy without this would have emptied the Quality page instead: no
  // context, no rows.
  const ROUTE = read("apps", "api", "src", "routes", "quality.ts");
  // Substring rather than regex: the assertion spans a line break, and a
  // pattern carrying its own newline escape is one transcription error away
  // from being a different pattern than the one written down.
  const scoped = ROUTE.replace(/\s+/g, " ");
  assert.ok(
    scoped.includes("withTenant(organization.id, () => Promise.all(["),
    "the trend handler must read inside a tenant context"
  );
  assert.ok(
    scoped.includes("withTenant(organization.id, () => askCopilot("),
    "the copilot handler must read inside a tenant context"
  );
});
