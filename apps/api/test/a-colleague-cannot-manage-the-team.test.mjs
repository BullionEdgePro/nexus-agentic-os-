// Staff could manage their own team (found 2026-09-28 while checking every
// screen after the rail was regrouped). requireTenantScope pins a /:slug route
// to the caller's business and does nothing else, so these routes — with no
// role check of their own — let any staff member add people, remove colleagues,
// rewrite a colleague's rota, or link/unlink a colleague's calendar. And the
// roster handed every colleague's email, phone, rota and sign-in device.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const ROUTE = read("apps", "api", "src", "routes", "employees.ts").replace(/\r\n/g, "\n");
const PAGE = read("apps", "web", "app", "deck", "team", "page.tsx");

const handler = (start) => {
  const at = ROUTE.indexOf(start);
  assert.ok(at > -1, `${start} is gone`);
  return ROUTE.slice(at, ROUTE.indexOf("\n});", at));
};

test("only the owner adds or removes staff", () => {
  assert.match(handler('employeesRoute.post("/:slug/employees"'), /scopeOf\(c\)\.role !== "operator"/);
  assert.match(handler('employeesRoute.delete("/:slug/employees/:employeeId"'), /scopeOf\(c\)\.role !== "operator"/);
});

test("a colleague's rota is the owner's to edit; your own is under /api/my/schedule", () => {
  const body = handler('employeesRoute.patch("/:slug/employees/:employeeId/schedule"');
  assert.match(body, /scopeOf\(c\)\.role !== "operator"/);
  // The role check comes before anything is read or written.
  assert.ok(body.indexOf('role !== "operator"') < body.indexOf("updateEmployeeSchedule"));
});

test("a calendar is linked or unlinked by its owner or the owner of the business", () => {
  assert.match(handler('employeesRoute.put("/:slug/employees/:employeeId/calendar"'), /caller\.role !== "operator" && caller\.employeeId !== employee\.id/);
  assert.match(handler('employeesRoute.delete("/:slug/employees/:employeeId/calendar"'), /caller\.role !== "operator" && caller\.employeeId !== c\.req\.param\("employeeId"\)/);
});

test("a colleague sees a name, not a file", () => {
  const body = handler('employeesRoute.get("/:slug/employees"');
  const staff = body.slice(body.indexOf('if (scopeOf(c).role !== "operator")'), body.indexOf("// Presence is resolved here"));
  assert.ok(staff.length > 100, "the staff branch is gone");
  for (const secret of ["email", "whatsappNumber:", "lastLoginAt", "lastLoginDevice", "workingHours:", "breakSchedule"]) {
    assert.ok(!staff.includes(secret), `the staff roster hands out ${secret}`);
  }
});

test("staff get the read-only directory, not the owner's workspace", () => {
  assert.match(PAGE, /session\?\.role === "employee"/);
  assert.match(PAGE, /<TeamDirectory/);
});
