/**
 * The owner connects a staff member's WhatsApp from Team (30 Oct 2026).
 *
 * Connecting used to need the staff member's own Nexus sign-in, because only a
 * staff session carries the employee the number is filed under. The owner asked
 * to stop signing in as somebody else just to run Meta's window for them. So the
 * owner gets the same connection, for a named person of a business they own —
 * the same one function underneath, so the two ways can never drift apart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");
const EMPLOYEES = read("apps", "api", "src", "routes", "employees.ts");
const CONNECTIONS = read("apps", "api", "src", "routes", "connections.ts");
const SERVICE = read("apps", "api", "src", "services", "whatsapp-connect.ts");

const handler = (source, marker) => {
  const start = source.slice(source.indexOf(marker));
  return start.slice(0, start.indexOf("\n});") + 4);
};
const OWNER_ROUTE = handler(EMPLOYEES, 'employeesRoute.post("/:slug/employees/:employeeId/whatsapp-connect"');
const SETUP_ROUTE = handler(EMPLOYEES, 'employeesRoute.get("/:slug/whatsapp-setup"');

test("the staff connect and the owner connect run one shared function", () => {
  assert.match(CONNECTIONS, /connectWhatsAppNumber\(\{ organizationId: owner\.organizationId, employeeId: owner\.employeeId \}/);
  assert.match(OWNER_ROUTE, /connectWhatsAppNumber\(\{ organizationId: organization\.id, employeeId: employee\.id \}/);
});

test("the shared function keeps every step the staff connect had", () => {
  for (const step of [
    "exchangeEmbeddedSignupCode(",
    "discoverWabaAndNumber(",
    "subscribeAppToWaba(",
    "fetchCoexistenceNumber(",
    "saveConnection(",
    "assignEmployeeWhatsAppNumber(",
    "requestChatHistory(",
    "wrongBusinessWarning(",
  ]) {
    assert.ok(SERVICE.includes(step), step);
  }
});

test("only the owner connects for somebody, and only for someone active in this business", () => {
  assert.match(OWNER_ROUTE, /scopeOf\(c\)\.role !== "operator"/);
  assert.match(OWNER_ROUTE, /employee\.organizationId !== organization\.id/);
  assert.match(OWNER_ROUTE, /!employee\.isActive/);
  const connectAt = OWNER_ROUTE.indexOf("connectWhatsAppNumber(");
  assert.ok(OWNER_ROUTE.indexOf('scopeOf(c).role !== "operator"') < connectAt);
  assert.ok(OWNER_ROUTE.indexOf("employee.organizationId !== organization.id") < connectAt);
});

test("the person comes from the address, never from the body", () => {
  assert.doesNotMatch(OWNER_ROUTE, /body\??\.employeeId/);
});

test("Team's WhatsApp setup hands the browser Meta's public signup settings", () => {
  // whatsappEmbeddedConfig() carries `configured` with the public ids.
  assert.match(SETUP_ROUTE, /signup: whatsappEmbeddedConfig\(\)/);
});
