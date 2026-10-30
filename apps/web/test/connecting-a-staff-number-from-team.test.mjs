/**
 * Connect WhatsApp from Team (30 Oct 2026): the owner runs Meta's window for a
 * staff member without signing in as them. The window itself is the same one
 * Connections opens, so it lives in one shared module.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Meta's signup window lives in one shared module", () => {
  const lib = read("../lib/whatsapp-signup.ts");
  assert.match(lib, /export async function launchWhatsAppSignup\(/);
  assert.match(lib, /featureType: "whatsapp_business_app_onboarding"/);
  const connections = read("../app/deck/my-clients/connections.tsx");
  assert.match(connections, /from "@\/lib\/whatsapp-signup"/);
  assert.doesNotMatch(connections, /function launchWhatsAppSignup\(/);
});

test("Team offers Connect WhatsApp for a person not yet connected, and files it under that person", () => {
  const panel = read("../app/deck/team/whatsapp-setup.tsx");
  assert.match(panel, /launchWhatsAppSignup\(setup\.signup\)/);
  assert.match(panel, /connectStaffWhatsApp\(business, person\.employeeId,/);
  assert.match(panel, /Connect WhatsApp/);
  const api = read("../lib/api.ts");
  assert.match(api, /\/api\/organizations\/\$\{orgSlug\}\/employees\/\$\{encodeURIComponent\(employeeId\)\}\/whatsapp-connect/);
});
