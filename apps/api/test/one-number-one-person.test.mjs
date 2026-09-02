// Multiple WhatsApp, done the only way it can be: a DEDICATED number per staff,
// registered on the company account. NOT a personal WhatsApp — that has no API
// and faking it bans the account.
//
// This file guards the assignment layer: a number belongs to exactly one
// person, the shared company line can never be handed out, and only the owner
// assigns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const DB = read("packages", "db", "src", "employees.ts");
const ROUTE = read("apps", "api", "src", "routes", "employees.ts");
const PICKER = read("apps", "web", "app", "deck", "team", "whatsapp-number.tsx");

test("assigning a number first frees it from anyone else", () => {
  // Two staff can never share one inbound line, or the router could not say
  // whose a message is. The assign clears the number from any other holder in
  // the same statement.
  const fn = DB.slice(DB.indexOf("export async function assignEmployeeWhatsAppNumber"));
  assert.match(fn, /whatsapp_phone_number_id = \$2 and id <> \$1/);
  assert.match(fn, /set whatsapp_phone_number_id = \$2/);
});

test("there is a lookup from a number to its owning employee", () => {
  // The hinge of inbound routing: an unmapped-to-org number may be a staff
  // member's own. Unscoped, because it runs before any tenant is known.
  assert.match(DB, /export async function findEmployeeByPhoneNumberId/);
  const fn = DB.slice(DB.indexOf("export async function findEmployeeByPhoneNumberId"));
  assert.match(fn, /whatsapp_phone_number_id = \$1 and is_active = true/);
});

test("the shared company number can never be assigned to a person", () => {
  // Handing the shared line to one staff member would route the whole
  // business's inbox to them. Refused outright.
  const patch = ROUTE.slice(ROUTE.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/whatsapp-number"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /=== organization\.whatsappPhoneNumberId/);
  assert.match(body, /422/);
});

test("only a number Meta actually holds can be assigned", () => {
  // Checked against the live account list, not trusted from the request — a
  // typo'd id would otherwise store and route to a number that does not exist.
  const patch = ROUTE.slice(ROUTE.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/whatsapp-number"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /listWabaNumbers\(organization\.whatsappBusinessAccountId\)/);
  assert.match(body, /not on this WhatsApp account/);
});

test("assigning is operator-only", () => {
  const patch = ROUTE.slice(ROUTE.indexOf('employeesRoute.patch("/:slug/employees/:employeeId/whatsapp-number"'));
  const body = patch.slice(0, patch.indexOf("\n});"));
  assert.match(body, /scope\?\.role !== "operator"/);
});

test("the picker states plainly this is not a personal WhatsApp", () => {
  // The single most important reliability message: nobody should think they can
  // connect the app on their phone.
  assert.match(PICKER, /[Nn]ot a personal WhatsApp|cannot be connected by any tool/);
});
