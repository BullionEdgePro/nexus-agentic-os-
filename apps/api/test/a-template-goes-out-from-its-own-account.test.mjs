// A template goes out from its own WhatsApp account (owner's request, 12 Oct
// 2026: "check the bulk message ... if still works fine").
//
// A WhatsApp template belongs to ONE WhatsApp Business Account, and Meta refuses
// a template sent from a number on another account. The mirror stored templates
// per business only, from the business's account (Zipicka's 1555307469433965).
// When +971 52 563 1476 joined through Coexistence it landed on a different
// account (1915340836093863, under the SFS portfolio) holding no templates at
// all — and My campaigns still offered Zipicka's two, so every staff bulk send
// from that number would have been refused per recipient.
//
// Now each template row records its account, each staff number records its
// account, the sync reads every staff account with that number's own token, a
// retire pass touches only the account it just read, and a campaign may only
// use a template from the account of the number it sends from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const MIGRATION = read("packages", "db", "migrations", "096-a-template-belongs-to-its-account.sql");
const BROADCASTS_DB = read("packages", "db", "src", "broadcasts.ts");
const EMPLOYEES_DB = read("packages", "db", "src", "employees.ts");
const SYNC = read("apps", "api", "src", "services", "template-sync.ts");
const CLIENT = read("apps", "api", "src", "lib", "whatsapp-client.ts");
const CAMPAIGNS = read("apps", "api", "src", "routes", "my-campaigns.ts");
const BROADCASTS = read("apps", "api", "src", "routes", "broadcasts.ts");
const CONNECTIONS = read("apps", "api", "src", "routes", "connections.ts");

const fn = (src, name) => {
  const at = src.indexOf(`export async function ${name}(`);
  assert.ok(at > -1, `${name} exists`);
  return src.slice(at, src.indexOf("\n}\n", at));
};

test("a template row and a staff number each record their WhatsApp account", () => {
  assert.match(MIGRATION, /alter table message_templates add column if not exists whatsapp_business_account_id text;/);
  assert.match(MIGRATION, /update message_templates t\s+set whatsapp_business_account_id = o\.whatsapp_business_account_id/);
  assert.match(MIGRATION, /drop constraint if exists message_templates_organization_id_meta_template_name_langua_key/);
  assert.match(MIGRATION, /on message_templates \(organization_id, coalesce\(whatsapp_business_account_id, ''\), meta_template_name, language\)/);
  assert.match(MIGRATION, /alter table employees add column if not exists whatsapp_business_account_id text;/);
  assert.match(MIGRATION, /set whatsapp_business_account_id = '1915340836093863'\s+where whatsapp_phone_number_id = '1358680447321869'/);
});

test("the mirror writes, lists and retires by account", () => {
  assert.match(fn(BROADCASTS_DB, "upsertTemplateFromMeta"), /whatsapp_business_account_id/);
  assert.match(fn(BROADCASTS_DB, "retireMissingTemplates"), /and whatsapp_business_account_id = \$3/);
  assert.match(fn(BROADCASTS_DB, "listBroadcastTemplates"), /and whatsapp_business_account_id is not distinct from \$2/);
  assert.match(fn(BROADCASTS_DB, "getBroadcastTemplate"), /whatsappBusinessAccountId: row\.whatsapp_business_account_id/);
});

test("every staff number's account is synced with that number's own sign-in", () => {
  assert.match(CLIENT, /export async function listMetaTemplates\(wabaId: string, accessToken: string = env\.metaAccessToken\)/);
  assert.match(SYNC, /export async function syncStaffNumberTemplates\(/);
  assert.match(SYNC, /connectionSecret\([^)]*"whatsapp"\)/);
  assert.match(SYNC, /results\.push\(\.\.\.\(await syncStaffNumberTemplates\(\)\)\)/);
});

test("a campaign offers and accepts only templates from the account it sends from", () => {
  assert.match(CAMPAIGNS, /listBroadcastTemplates\(desk\.organizationId, sendingAccount\)/);
  assert.match(CAMPAIGNS, /template\.whatsappBusinessAccountId !== sendingAccount/);
  assert.match(BROADCASTS, /listBroadcastTemplates\(organization\.id, organization\.whatsappBusinessAccountId\)/);
});

test("connecting a number remembers its account", () => {
  assert.match(CONNECTIONS, /wabaId: connectedWabaId,/);
  assert.match(fn(EMPLOYEES_DB, "assignEmployeeWhatsAppNumber"), /whatsapp_business_account_id = \$5/);
});

test("a business broadcast cannot be handed a staff number's template by id", () => {
  assert.match(BROADCASTS, /template\.whatsappBusinessAccountId !== organization\.whatsappBusinessAccountId/);
});
