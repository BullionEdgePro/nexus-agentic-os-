// The marketplace only goes one way, and this file is what keeps it that way.
//
// F13's egress policy, decided 2026-08-15: NOTHING LEAVES. A business installs
// a template, a procedure or a knowledge pack. It never contributes one.
//
// The guarantee is meant to be structural rather than remembered — `catalog_items`
// has no organization_id and no foreign key to any tenant table, so there is
// nowhere for one business's material to be recorded. That property is worth
// more than the rule it replaces, but only for as long as it holds: a later
// migration adding `contributed_by uuid references organizations(id)` would look
// like a reasonable attribution feature and would quietly turn this into a
// different product.
//
// It matters most for the two law firms. Juris Prime Legal and ABR both answer
// on the same WhatsApp number. A catalogue able to carry one firm's intake to
// the other is not this feature with a risk attached.
//
// Source-text assertions, like the rest of this suite. They cannot prove what
// the live database contains — `rls-verify` and `schema-check` do that — but
// they can prove that the shape nobody may write is not written anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const migrationsDir = join(root, "packages", "db", "migrations");
const MIGRATIONS = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => ({ file: f, sql: readFileSync(join(migrationsDir, f), "utf8") }));

const CATALOG_DB = read("packages", "db", "src", "catalog.ts");
const CATALOG_ROUTE = read("apps", "api", "src", "routes", "catalog.ts");
const CLIENT = read("packages", "db", "src", "client.ts");
const API_INDEX = read("apps", "api", "src", "index.ts");
const NAV = read("apps", "web", "lib", "nav.tsx");

/** Comments stripped, so an assertion about code is never satisfied by prose. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
const sqlCode = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

// ============================================================
// The table cannot hold a business's material
// ============================================================

test("no migration gives catalog_items a tenant column", () => {
  // The create statement and every later alter, together. A column added in
  // migration 057 is exactly as fatal as one in 039, and rather harder to spot.
  for (const { file, sql } of MIGRATIONS) {
    const stripped = sqlCode(sql);

    const created = /create table (?:if not exists )?catalog_items\s*\(([\s\S]*?)\n\);/i.exec(
      stripped
    );
    if (created) {
      const body = created[1];
      assert.ok(
        !/organization_id/i.test(body),
        `${file}: catalog_items has an organization_id — the whole boundary is that it cannot`
      );
      assert.ok(
        !/references\s+(organizations|contacts|conversations|messages|procedures|knowledge_\w+)/i.test(
          body
        ),
        `${file}: catalog_items has a foreign key to a tenant table`
      );
    }

    const altered = [...stripped.matchAll(/alter table\s+catalog_items\b([^;]*);/gi)];
    for (const [statement] of altered) {
      assert.ok(
        !/add column[^;]*organization_id/i.test(statement),
        `${file}: adds organization_id to catalog_items`
      );
      assert.ok(
        !/references\s+(organizations|contacts|conversations|messages|procedures|knowledge_\w+)/i.test(
          statement
        ),
        `${file}: adds a tenant foreign key to catalog_items`
      );
    }
  }
});

test("the application role may read the catalogue and never author it", () => {
  const marketplace = MIGRATIONS.find((m) => m.file === "039-marketplace.sql");
  assert.ok(marketplace, "039-marketplace.sql is missing");
  const sql = sqlCode(marketplace.sql);

  // Revoke first. `grant select` does not remove an insert an earlier blanket
  // grant already placed — that was the live finding on 2026-08-17, discovered
  // by reading role_table_grants back rather than by trusting the grant line.
  const revokeAt = sql.indexOf("revoke all on catalog_items from nexus_app");
  const grantAt = sql.indexOf("grant select on catalog_items to nexus_app");
  assert.ok(revokeAt !== -1, "039 must revoke on catalog_items before granting");
  assert.ok(grantAt !== -1, "039 must grant select on catalog_items");
  assert.ok(revokeAt < grantAt, "the revoke has to come before the grant, or it undoes it");

  // No insert/update/delete anywhere in the file for this table.
  assert.ok(
    !/grant[^;]*\b(insert|update|delete)\b[^;]*\bon catalog_items\b/i.test(sql),
    "nexus_app must not be able to write catalog_items — authoring is an owner action"
  );
});

// ============================================================
// Nothing in the application can write one either
// ============================================================

test("there is no function that authors a catalogue item", () => {
  // Belt and braces with the grant above, and the more readable of the two: a
  // reviewer looking for "can this thing publish?" reads the exports, not the
  // privileges.
  const db = code(CATALOG_DB);
  assert.ok(
    !/insert into catalog_items/i.test(db),
    "packages/db/src/catalog.ts writes catalog_items — publishing is authoring, done in a migration"
  );
  assert.ok(
    !/(update|delete from) catalog_items/i.test(db),
    "packages/db/src/catalog.ts modifies catalog_items"
  );
});

test("no route accepts a contribution", () => {
  const route = code(CATALOG_ROUTE);
  // Every write path this router exposes is about installs. A POST or PUT
  // landing on the catalogue itself is the shape that has to stay absent.
  const writes = [...route.matchAll(/catalogRoute\.(post|put|patch|delete)\(\s*"([^"]*)"/g)];
  assert.ok(writes.length > 0, "expected the install endpoints");
  for (const [, method, path] of writes) {
    assert.ok(
      path.startsWith("/installs"),
      `catalogRoute.${method}("${path}") writes something other than an install`
    );
  }
});

// ============================================================
// The install side IS one business's own business
// ============================================================

test("catalog_installs is tenant-scoped and catalog_items deliberately is not", () => {
  const list = /const TENANT_SCOPED_TABLES = \[([\s\S]*?)\];/.exec(CLIENT);
  assert.ok(list, "TENANT_SCOPED_TABLES not found in client.ts");
  assert.match(list[1], /"catalog_installs"/, "catalog_installs must be tenant-scoped");
  assert.ok(
    !/"catalog_items"/.test(list[1]),
    "catalog_items must NOT be listed — a registry every business reads cannot be scoped to one"
  );
});

test("a business can only have one live install of a pack", () => {
  // 039 wrote `unique (organization_id, catalog_item_id, installed_at)`, which
  // enforces nothing: installed_at defaults to now(), so two installs in two
  // requests carry two timestamps and both are accepted. 040 replaces it with a
  // partial unique index, which is the only shape that can express "unless it
  // has been removed".
  const fix = MIGRATIONS.find((m) => m.file === "040-marketplace-install-once.sql");
  assert.ok(fix, "040-marketplace-install-once.sql is missing");
  const sql = sqlCode(fix.sql);
  assert.match(sql, /drop constraint if exists catalog_install_once/i);
  assert.match(
    sql,
    /create unique index[\s\S]*on catalog_installs \(organization_id, catalog_item_id\)[\s\S]*where removed_at is null/i
  );

  // And the application must lean on it rather than pre-checking, or the rule
  // is a race between two clicks again.
  assert.match(code(CATALOG_DB), /UNIQUE_VIOLATION/);
  assert.match(code(CATALOG_DB), /already-installed/);
});

test("removing an install stamps it rather than deleting it", () => {
  const db = code(CATALOG_DB);
  assert.ok(
    !/delete from catalog_installs/i.test(db),
    "a business that ran a pack ran it — the row is the only record of that"
  );
  assert.match(db, /set removed_at = now\(\)/);
});

test("installing is not activating", () => {
  const db = code(CATALOG_DB);
  // The insert names three columns and is_active is not one of them, so the
  // column default (false, migration 039) stands. An insert that set it would
  // put material into the prompt for every future customer with nobody deciding.
  const insert = /insert into catalog_installs \(([^)]*)\)/i.exec(db);
  assert.ok(insert, "the install insert is missing");
  assert.ok(
    !/is_active/i.test(insert[1]),
    "the install path sets is_active — a pack must arrive switched off"
  );
});

test("the install path copies the version rather than referencing it", () => {
  assert.match(code(CATALOG_DB), /installed_version/);
  // Read from the item at install time. If this ever became a join against
  // catalog_items.version, "what is this agent running" would have no answer
  // after the catalogue moved on.
  assert.match(code(CATALOG_DB), /item\.version/);
});

// ============================================================
// Who may reach it
// ============================================================

test("the marketplace is operator-only in both applications", () => {
  // Installing a pack changes what every customer of that business is
  // eventually told, and the screen shows all five businesses side by side.
  // staff-see-only-their-business.test.mjs checks the two lists agree; this
  // checks the decision itself is the one that was made.
  assert.match(code(API_INDEX), /app\.use\("\/api\/catalog", operatorOnly\)/);
  assert.match(code(API_INDEX), /app\.use\("\/api\/catalog\/\*", operatorOnly\)/);

  const entry = NAV.split(/href:\s*"/).find((chunk) => chunk.startsWith("/deck/catalogue"));
  assert.ok(entry, "the catalogue has no nav entry");
  assert.match(entry, /operatorOnly:\s*true/);
});

test("an install is scoped by business, not by id alone", () => {
  // /api/catalog runs cross-tenant, so RLS is not narrowing anything here: the
  // organization_id in the query IS the boundary. A remove that took only an
  // install id would reach any business's row.
  const db = code(CATALOG_DB);
  assert.match(db, /where id = \$1\s*\n?\s*and organization_id = \$2/);
  assert.match(code(CATALOG_ROUTE), /findOrganizationBySlug/);
  console.log("PASS: catalogue is install-only, operator-only, and one-live-install-per-pack");
});
