// Nothing else shows a staff member a colleague's work either.
//
// The companion to a-staff-member-sees-only-their-own: once conversations were
// private, every OTHER route that reads the same business's data was a second
// door (sweep of 22 Oct 2026). Each assertion below closes one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");
const R = (f) => read("apps", "api", "src", "routes", f);
const handler = (src, marker) => {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, `handler not found: ${marker}`);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf("\n});") + 4);
};

test("a staff member asks only for their own conversations by employee id", () => {
  const body = handler(R("employees.ts"), 'employeesRoute.get("/:slug/employees/:employeeId/conversations"');
  assert.match(body, /role === "employee" && scope\.employeeId !== employee\.id/);
});

test("a staff member's leads are their own, whatever the query says", () => {
  const body = handler(R("employees.ts"), 'employeesRoute.get("/:slug/leads"');
  assert.match(body, /role === "employee"/);
});

test("customers: a staff member sees the clients in their own book", () => {
  const ROUTE = R("contacts.ts");
  assert.match(handler(ROUTE, 'contactsRoute.get("/:slug/contacts", '), /ownedBy/);
  assert.match(handler(ROUTE, 'contactsRoute.get("/:slug/contacts/:contactId"'), /ownedBy/);
  const DB = read("packages", "db", "src", "contacts.ts");
  assert.match(DB, /ct\.owner_employee_id = \$\d+::uuid/);
});

test("exports of the whole customer base are the admin's", () => {
  const ROUTE = R("contacts.ts");
  for (const marker of [
    'contactsRoute.get("/:slug/export/customers.csv"',
    'contactsRoute.get("/:slug/export/messages.csv"',
    'contactsRoute.get("/:slug/contacts/:contactId/export.json"',
  ]) {
    assert.match(handler(ROUTE, marker), /role !== "operator"/, marker);
  }
});

test("search finds a staff member's own things only", () => {
  assert.match(R("search.ts"), /search\(term, organizationId, 8, scope\.role === "employee" \? scope\.employeeId/);
  const DB = read("packages", "db", "src", "search.ts");
  assert.match(DB, /owner_employee_id = \$\d+::uuid/);
  assert.match(DB, /t\.employee_id = \$\d+::uuid/);
});

test("tasks and bookings: a staff member's list is theirs without asking", () => {
  assert.match(R("tasks.ts"), /const mine = scope\.role !== "operator";/);
  assert.match(R("bookings.ts"), /const mine = scope\.role !== "operator";/);
});

test("findings: a staff member sees the ones about their own conversations", () => {
  const ROUTE = R("operators.ts");
  assert.match(ROUTE, /conversationVisibleTo\(/);
  assert.match(ROUTE, /subjectKind === "conversation"/);
});

test("automation run logs are the admin's", () => {
  const body = handler(R("automations.ts"), 'automationsRoute.get("/runs"');
  assert.match(body, /role !== "operator"/);
});
