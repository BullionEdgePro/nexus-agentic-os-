// A newly connected staff number gets its business's messages by itself.
//
// FOUND 22 OCT 2026. Keshav Arora (SFS) connected his own WhatsApp Business
// number and it landed on a new WhatsApp account, 1598768785203832, holding no
// templates at all. Customer chats reached him; a campaign could not, because
// WhatsApp only lets a business start a conversation with an approved template,
// and templates reached a new account only when somebody ran
// scripts/provision-templates.ts by hand — a script that knew only the company
// account and the platform token. Every staff member who connected next would
// have hit the same wall.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { CAMPAIGN_TEMPLATES, missingCampaignTemplates } from "../src/lib/campaign-templates.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SYNC = readFileSync(join(here, "..", "src", "services", "template-sync.ts"), "utf8");
const SCRIPT = readFileSync(join(here, "..", "src", "scripts", "provision-templates.ts"), "utf8");

test("an empty SFS account is missing both SFS messages", () => {
  assert.deepEqual(
    missingCampaignTemplates("sfs-international", []).map((spec) => spec.name),
    ["sfs_property_update", "sfs_general_update"]
  );
});

test("a message already at Meta is not submitted again", () => {
  assert.deepEqual(
    missingCampaignTemplates("sfs-international", ["sfs_property_update"]).map((spec) => spec.name),
    ["sfs_general_update"]
  );
});

test("presence is by name, whatever Meta decided — a rejected one is never resubmitted in a loop", () => {
  // The caller passes every name Meta lists, PENDING and REJECTED included.
  assert.deepEqual(missingCampaignTemplates("sfs-international", ["sfs_property_update", "sfs_general_update"]), []);
});

test("a business with no catalogue, and the App Review sandbox, get nothing", () => {
  assert.deepEqual(missingCampaignTemplates("no-such-business", []), []);
  assert.deepEqual(missingCampaignTemplates("review-demo", []), []);
});

test("every catalogue message names its business and gives Meta an example per placeholder", () => {
  for (const [slug, specs] of Object.entries(CAMPAIGN_TEMPLATES)) {
    for (const spec of specs) {
      const placeholders = new Set(spec.body.match(/\{\{\d+\}\}/g) ?? []).size;
      assert.equal(spec.example.length, placeholders, `${spec.name}: Meta rejects a placeholder without an example`);
      assert.ok(spec.name.startsWith(slug.replace(/-international$/, "").replace(/-/g, "_")), `${spec.name} is filed under ${slug}`);
    }
  }
});

test("the staff sync submits what is missing with the number's own token", () => {
  assert.match(SYNC, /missingCampaignTemplates\(/);
  assert.match(SYNC, /createMetaTemplate\(account\.wabaId, spec, secret\.accessToken\)/);
});

test("a number with no stored token is reported, not silently skipped", () => {
  // An owner-registered number (Team) can have no `whatsapp` connection row.
  assert.match(SYNC, /if \(!secret\) \{\s*logger\.warn\(/);
});

test("the hand-run script reads the same catalogue rather than its own copy", () => {
  assert.match(SCRIPT, /CAMPAIGN_TEMPLATES/);
  assert.doesNotMatch(SCRIPT, /const PROVISIONS: Provision\[\] = \[/);
});
