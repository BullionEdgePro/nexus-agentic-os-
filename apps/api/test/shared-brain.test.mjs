// F5 — the shared pattern store, and the one guard that makes it honest.
//
// A pooled table across five businesses where only one has traffic will happily
// aggregate that business's conversations, label the result "platform
// intelligence", and hand it straight back. No error, no symptom, and a number
// nobody downstream can tell is a mirror. That is the failure this file exists
// to prevent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const BRAIN = read("packages", "db", "src", "shared-brain.ts");
const MIGRATION = read("packages", "db", "migrations", "020-shared-patterns.sql");
const REDACT = read("packages", "governance", "src", "redact.ts");
const CLIENT = read("packages", "db", "src", "client.ts");
const ROLLUP = read("apps", "api", "src", "services", "quality-rollup.ts");
const ROUTE = read("apps", "api", "src", "routes", "quality.ts");

// ============================================================
// One tenant is not a platform
// ============================================================

test("a pattern needs two contributing businesses before it is shared guidance", () => {
  assert.match(BRAIN, /export const MIN_CONTRIBUTING_TENANTS = 2/);
  assert.match(BRAIN, /where contributing_tenants >= \$1/);
  assert.match(MIGRATION, /contributing_tenants\s+integer not null default 0/);
});

test("the tenant count is distinct organizations, not rows", () => {
  // count(*) would be satisfied by one business having many conversations,
  // which is precisely the situation today.
  assert.match(BRAIN, /count\(distinct organization_id\)/);
});

test("the filter lives in the read path, not in the caller", () => {
  // Returning everything and trusting callers to filter means the first
  // careless one presents a tenant's own history back to it as platform
  // knowledge, and nothing downstream can tell.
  const guidance = BRAIN.slice(BRAIN.indexOf("export async function getSharedGuidance"));
  assert.match(guidance, /contributing_tenants >= \$1/);
  assert.match(guidance, /sample_count >= \$2/);
});

test("a small sample is excluded even when two businesses contributed", () => {
  // Two businesses and three conversations is still noise, and a rate computed
  // from three samples swings wildly enough to read as a trend.
  assert.match(BRAIN, /minSamples = 20/);
});

test("an empty brain explains itself rather than just being empty", () => {
  // An empty pooled table is indistinguishable from a broken one unless it says
  // which it is.
  assert.match(BRAIN, /blockedBecause/);
  assert.match(BRAIN, /Only one business has customer traffic/);
  assert.match(BRAIN, /handed back to it/);
});

// ============================================================
// Nothing anyone wrote can reach this table
// ============================================================

test("the pooled table has no free-text column", () => {
  // The structural guarantee. Redaction handles patterns; names and the
  // substance of an enquiry are not patterns — so the defence is that there is
  // no column able to receive prose in the first place.
  const columns = MIGRATION.slice(
    MIGRATION.indexOf("create table if not exists shared_patterns"),
    MIGRATION.indexOf("primary key")
  );
  for (const forbidden of ["body", "content", "message_text", "note", "summary", "display_name"]) {
    assert.ok(!new RegExp(`\\b${forbidden}\\b`).test(columns), `${forbidden} must not be a column here`);
  }
});

/** The pooled table's columns, name and declared type, read from its migration. */
function pooledColumns() {
  const open = MIGRATION.indexOf("create table if not exists shared_patterns (");
  const close = MIGRATION.indexOf(");", open);
  const body = MIGRATION.slice(MIGRATION.indexOf("(", open) + 1, close);
  const columns = [];
  for (const raw of body.split(String.fromCharCode(10))) {
    const line = raw.trim();
    if (!line || line.startsWith("--") || line.startsWith("primary key")) continue;
    const parts = line.replace(",", " ").split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    columns.push({ name: parts[0], type: parts[1].toLowerCase() });
  }
  return columns;
}

test("nothing but counts and allow-listed identity crosses the tenant boundary", () => {
  // THE DIRECTION THAT MATTERS, and the one this test used to have backwards.
  //
  // It asserted four named fields were ON the SHAREABLE list, which is the safe
  // direction: those four are there, they were there when somebody typed them,
  // and nothing about that check moves if a fifth column appears. The danger is
  // the opposite one -- a column added to the pooled table that carries
  // something the allow-list never sanctioned. This table has no
  // organization_id and no RLS by design, so a text column on it is one
  // business's words readable by all five.
  //
  // The rule is the table's own comment: "Counts only -- nothing that could
  // reconstruct a conversation." So every column must be a number or a
  // timestamp, unless its NAME is on SHAREABLE, which is how intent_category
  // and language are allowed to be text.
  const columns = pooledColumns();
  assert.ok(columns.length >= 8, `only ${columns.length} columns parsed from migration 020`);

  const NUMERIC = ["integer", "numeric", "bigint", "smallint", "real", "double", "timestamptz", "boolean"];
  for (const column of columns) {
    const isCount = NUMERIC.some((type) => column.type.startsWith(type));
    if (isCount) continue;
    assert.ok(
      REDACT.includes(`"${column.name}"`),
      `shared_patterns.${column.name} is ${column.type} and is not on the SHAREABLE allow-list. ` +
        `This table has no organization_id and no RLS: a text column here is one business's ` +
        `words readable by the other four.`
    );
  }
});

test("the four fields the pool is built from are still allow-listed", () => {
  // Kept from the original, because the check above would also pass if somebody
  // emptied SHAREABLE and removed the text columns. Both directions, cheaply.
  for (const field of ["intent_category", "language", "message_count", "resolution_seconds"]) {
    assert.ok(REDACT.includes(`"${field}"`), `${field} should be on the SHAREABLE list`);
  }
});

test("the pooled table is deliberately not tenant-scoped", () => {
  // It holds no tenant rows, so it gets no RLS policy and no entry in the
  // guard list. Stating it here stops a later reader "fixing" the omission.
  assert.ok(
    !/"shared_patterns"/.test(CLIENT),
    "shared_patterns must not be in TENANT_SCOPED_TABLES — it has no organization_id"
  );
  assert.match(MIGRATION, /NOT in TENANT_SCOPED_TABLES/);
  assert.match(MIGRATION, /NO organization_id, deliberately/);
});

// ============================================================
// Mechanics
// ============================================================

test("rates are per conversation, not per metric row", () => {
  // Without the per-conversation grouping, a chatty conversation would weigh
  // more than a brief one and the escalation rate would track verbosity.
  assert.match(BRAIN, /with per_conversation as \(/);
  assert.match(BRAIN, /group by cm\.organization_id, cm\.conversation_id/);
});

test("patterns are recomputed, not accumulated", () => {
  assert.match(BRAIN, /on conflict \(intent_category, language\) do update/);
  assert.ok(!/sample_count\s*=\s*shared_patterns\.sample_count\s*\+/.test(BRAIN));
});

test("the cross-tenant read says why it spans every business", () => {
  assert.match(BRAIN, /withAllTenants\("F5 shared patterns: an aggregate across every business"/);
});

test("a failure here cannot break the per-tenant rollups", () => {
  // Those are the numbers an owner actually looks at.
  const tail = ROLLUP.slice(ROLLUP.indexOf("rollUpSharedPatterns"));
  assert.match(tail, /catch \(err\)/);
});

test("the literal /shared route is declared before the :slug parameter", () => {
  // Hono matches in declaration order; declared after, this route would never
  // be reached and would simply 404 as an unknown business.
  assert.ok(
    ROUTE.indexOf('qualityRoute.get("/shared"') < ROUTE.indexOf('qualityRoute.get("/:slug"'),
    "/shared must be declared before /:slug"
  );
  console.log("PASS: shared patterns need two businesses, hold no prose, and explain their own emptiness");
});
