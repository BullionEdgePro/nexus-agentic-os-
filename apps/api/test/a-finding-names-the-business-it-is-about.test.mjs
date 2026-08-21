// Every finding about a routed conversation named the wrong business.
//
// Measured on production 2026-08-19, from findings already in the table:
//
//   customer-waiting  warn  filed against zipicka, customer was sfs-international  (12 Aug)
//   customer-waiting  warn  filed against zipicka, customer was juris-prime        (17 Aug)
//
// The second of those IS the seventeen-hour silence: a customer picked Juris
// Prime from the triage menu, got nothing back, and the operator that noticed
// filed it against the wrong firm.
//
// All five businesses answer on Zipicka's number, so a routed conversation
// carries organization_id = zipicka with routed_organization_id naming who is
// serving. The sweep runs `withTenant(organization.id)` per business, and under
// RLS that conversation is visible only inside ZIPICKA's turn -- so the finding
// is filed against Zipicka, correctly according to the row and wrongly
// according to the customer.
//
// Both directions cost something. The console labels it "Zipicka", and the
// label is the part that tells somebody who to call. An employee session is
// filtered to their own organization, so a Juris Prime employee never sees
// their own waiting customer and a Zipicka employee sees one they cannot help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const OPERATORS = read("apps", "api", "src", "services", "operators.ts");
const DB = read("packages", "db", "src", "operators.ts");

/** One operator's definition, so an assertion cannot match its neighbour. */
function operator(slug) {
  const marker = `slug: "${slug}"`;
  const start = OPERATORS.lastIndexOf("const ", OPERATORS.indexOf(marker));
  assert.ok(start > -1, `${slug} not found`);
  const next = OPERATORS.indexOf("\nconst ", start + 1);
  return next === -1 ? OPERATORS.slice(start) : OPERATORS.slice(start, next);
}

test("both per-conversation operators resolve the serving business", () => {
  // These two raise one finding per CONVERSATION, and a conversation is the
  // thing that can be routed. Both are also the two that were measured wrong.
  for (const slug of ["customer-waiting", "handover-abandoned"]) {
    const body = operator(slug);
    assert.ok(
      body.includes("coalesce(c.routed_organization_id, c.organization_id) as serving_organization_id"),
      `${slug} must read the serving business`
    );
    assert.ok(
      body.includes("servingOrganizationId: row.serving_organization_id"),
      `${slug} must put it on the finding`
    );
  }
});

test("reconciliation stays keyed on the business that OWNS the finding", () => {
  // The subtle half. Filing Juris Prime's finding under Juris Prime would put
  // it in reach of Juris Prime's own turn in the sweep, which sees no routed
  // conversations at all under RLS, produces an empty list, and RETRACTS the
  // finding that had just been raised. The finding must stay owned by the
  // transaction that can see it; which business it is about is a column.
  const retracted = DB.slice(DB.indexOf("retracted as ("), DB.indexOf("returning", DB.indexOf("retracted as (")));
  assert.ok(
    retracted.includes("where f.organization_id = $1"),
    "retraction must match the owning organization, never the serving one"
  );
  assert.ok(
    !retracted.includes("serving_organization_id"),
    "reconciliation must not resolve through the serving business"
  );
});

test("every read a person sees resolves through the serving business", () => {
  // The label, the list filter, the counts, and the per-operator last-seen.
  // Missing any one of them leaves a page that disagrees with itself.
  const uses = DB.split("${FINDING_BUSINESS}").length - 1;
  assert.ok(uses >= 5, `expected the serving business in every display read, found ${uses}`);
  assert.match(DB, /coalesce\(f\.serving_organization_id, f\.organization_id\)/);
});

test("the column exists and is deliberately not backfilled", () => {
  const sql = readFileSync(
    join(root, "packages", "db", "migrations", "053-finding-names-the-serving-business.sql"),
    "utf8"
  );
  assert.match(sql, /add column if not exists serving_organization_id uuid/);
  assert.match(sql, /was not added/);
  // A backfilled value would be a guess wearing the same shape as a record: it
  // would make rows produced before the fix indistinguishable from ones after.
  assert.ok(!/update operator_findings/i.test(sql), "existing rows must be left null");
});

test("no migration after the derived RLS pass creates a table", () => {
  // This replaces "052 must be the last migration", which was a proxy for the
  // real invariant and would have blocked every future migration. What matters
  // is that no TABLE is created after the pass that protects tables -- 053 adds
  // a column to one that already has a policy.
  const dir = join(root, "packages", "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const rls = files.findIndex((f) => f.includes("rls-for-every-tenant-table"));
  assert.ok(rls > -1, "the derived RLS pass is missing");
  // TIGHTENED, because the blanket ban was itself a proxy. What actually
  // matters is that a table created after the pass is not left unprotected --
  // not that no table is ever created again, which would freeze the schema.
  // 062 creates conversation_custody and enables RLS with a policy in the same
  // file, which satisfies the invariant the pass exists to hold.
  //
  // A check that forbids the safe case teaches people to delete the check.
  for (const file of files.slice(rls + 1)) {
    const sql = readFileSync(join(dir, file), "utf8");
    const created = [...sql.matchAll(/create table (?:if not exists )?([a-z_]+)/gi)].map((m) => m[1]);
    for (const table of created) {
      assert.match(
        sql,
        new RegExp(`alter table ${table}\\s+enable row level security`, "i"),
        `${file} creates ${table} after the derived RLS pass without enabling RLS on it`
      );
      assert.match(
        sql,
        new RegExp(`create policy [a-z_]+ on ${table}`, "i"),
        `${file} enables RLS on ${table} but defines no policy, so it denies everything`
      );
    }
  }
});
