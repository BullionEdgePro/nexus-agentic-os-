// The org chart's storage and API (owner-approved 14 Oct 2026). Nexus staff are
// never edited: the chart keeps its own rows (reports-to, department, people
// not on Nexus, vacancies) behind the tenant policy, plus one group row naming
// the owner of every company. Writes refuse loops and lines to strangers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("packages", "db", "migrations", "098-every-company-has-a-shape.sql");
const HQ = read("packages", "db", "src", "hq.ts");
const CLIENT = read("packages", "db", "src", "client.ts");
const ROUTE = read("apps", "api", "src", "routes", "hq.ts");
const WEB = read("apps", "web", "lib", "api.ts");

test("chart rows are tenant data; the owner of the group is one row", () => {
  assert.match(MIGRATION, /create table if not exists hq_org_members \(/);
  assert.match(MIGRATION, /kind\s+text not null check \(kind in \('staff', 'manual', 'vacancy'\)\)/);
  assert.match(MIGRATION, /alter table hq_org_members enable row level security/);
  assert.match(MIGRATION, /create policy hq_org_members_tenant_isolation on hq_org_members/);
  assert.match(MIGRATION, /create unique index if not exists idx_hq_org_members_employee/);
  assert.match(MIGRATION, /create table if not exists hq_group \(/);
  assert.match(MIGRATION, /alter table hq_group enable row level security/);
  assert.match(MIGRATION, /'Atif Ali Ali Said'/);
  assert.match(CLIENT, /"hq_org_members"/);
});

test("the chart's reads and writes name their cross-tenant reason", () => {
  for (const name of ["getHqGroup", "listOrgMembers", "upsertOrgMember", "deleteOrgMember"]) {
    const at = HQ.indexOf(`export async function ${name}(`);
    assert.ok(at > -1, `${name} exists`);
    assert.match(HQ.slice(at, HQ.indexOf("\n}\n", at)), /withAllTenants\("business hq: /);
  }
});

test("the group view is matched before a business slug", () => {
  const group = ROUTE.indexOf('hqRoute.get("/group"');
  const slug = ROUTE.indexOf('hqRoute.get("/:slug"');
  assert.ok(group > -1 && group < slug, "/group is registered before /:slug");
});

test("a reporting line must point inside this company's chart and never loop", () => {
  assert.match(ROUTE, /wouldCreateLoop\(/);
  assert.match(ROUTE, /That would make .* report to someone who reports to them\./);
  assert.match(ROUTE, /"Choose someone on this company's chart\."/);
  assert.match(ROUTE, /buildOrgChart\(/);
});

test("the web client calls every chart route", () => {
  assert.match(WEB, /request\("\/api\/hq\/group"\)/);
  assert.match(WEB, /`\/api\/hq\/\$\{slug\}\/org`/);
  assert.match(WEB, /`\/api\/hq\/\$\{slug\}\/org\/\$\{/);
});
