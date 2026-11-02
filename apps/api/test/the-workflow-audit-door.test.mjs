// The workflow audit's door (2 Nov 2026): one read-only route under
// /api/organizations/:slug, so requireTenantScope lets an admin into any
// business and staff only into their own; 7, 30 or 90 days and nothing else.
// Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §2, §7.1
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseAuditDays } from "../src/routes/workflow-audit.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const INDEX = read("apps", "api", "src", "index.ts");
const ROUTE = read("apps", "api", "src", "routes", "workflow-audit.ts");
const API = read("apps", "web", "lib", "api.ts");

test("only 7, 30 or 90 days, 30 by default", () => {
  assert.equal(parseAuditDays(undefined), 30);
  assert.deepEqual(["7", "30", "90"].map(parseAuditDays), [7, 30, 90]);
  for (const bad of ["0", "14", "365", "abc", "-7", "30.5", " 30", ""]) assert.equal(parseAuditDays(bad), null, bad);
});

test("the door sits behind the tenant guard, under /api/organizations/:slug", () => {
  assert.match(INDEX, /app\.route\("\/api\/organizations", workflowAuditRoute\)/);
  // Mounted after the guard that every /api/organizations/:slug/* route passes.
  assert.ok(
    INDEX.indexOf('app.use("/api/organizations/:slug/*", requireTenantScope)') < INDEX.indexOf("workflowAuditRoute)"),
    "the route is mounted before the tenant guard"
  );
  assert.match(ROUTE, /workflowAuditRoute\.get\("\/:slug\/workflow-audit"/);
  assert.match(ROUTE, /days must be 7, 30 or 90/);
  assert.match(ROUTE, /timezone: organization\.timezone/);
  assert.match(API, /\/api\/organizations\/\$\{slug\}\/workflow-audit\?days=\$\{days\}/);
});
