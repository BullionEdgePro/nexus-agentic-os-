/**
 * Removing a staff member was one click with no confirmation and no undo
 * (29 Oct 2026): two SFS staff went in the same minute, and the only way back
 * was editing the database. Removal never deleted anything, so the owner can
 * now see who was removed and restore them, and the click asks first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const ROUTE = read("apps", "api", "src", "routes", "employees.ts");
const DB = read("packages", "db", "src", "employees.ts");
const SCREEN = read("apps", "web", "app", "deck", "team", "team-workspace.tsx");

const handler = (marker) => ROUTE.slice(ROUTE.indexOf(marker), ROUTE.indexOf("});", ROUTE.indexOf(marker)));

test("only the owner can list or restore removed staff", () => {
  for (const marker of ['employeesRoute.get("/:slug/employees-removed"', 'employeesRoute.post("/:slug/employees/:employeeId/restore"']) {
    assert.ok(ROUTE.includes(marker), marker);
    assert.match(handler(marker), /scopeOf\(c\)\.role !== "operator"/);
  }
});

test("a restore is for this business's person only", () => {
  assert.match(handler('employeesRoute.post("/:slug/employees/:employeeId/restore"'), /employee\.organizationId !== organization\.id/);
});

test("restoring flips the flag back and touches nothing else", () => {
  const fn = DB.slice(DB.indexOf("export async function reactivateEmployee"), DB.indexOf("export async function reactivateEmployee") + 400);
  assert.match(fn, /set is_active = true, updated_at = now\(\) where id = \$1 and is_active = false/);
});

test("removing asks first, and says where to undo it", () => {
  const fn = SCREEN.slice(SCREEN.indexOf("async function onRemove"), SCREEN.indexOf("async function onRestore"));
  assert.ok(fn.indexOf("window.confirm(") < fn.indexOf("removeTeamMember("), "the confirmation comes before the removal");
  assert.match(fn, /Removed staff/);
});
