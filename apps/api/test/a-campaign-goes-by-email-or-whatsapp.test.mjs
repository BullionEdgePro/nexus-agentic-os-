// A campaign goes by email or by WhatsApp, never both (26 Oct 2026).
//
// Ralph's only campaign (22 Oct) was queued on WhatsApp to 57 customers who had
// only ever emailed — it reached nobody, and the fix left every email customer
// unreachable. The owner: "fix the bulk messaging separated for email and
// whatsapp, be creative and reliable".
// Spec: docs/superpowers/specs/2026-10-26-email-campaigns-design.md
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { emailContentRefusal, looksLikeAnEmail } from "../src/routes/my-campaigns.ts";
import { describePlan } from "../../web/app/deck/my-campaigns/describe-plan.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("the migration gives every campaign one channel and keeps old rows valid", () => {
  const MIGRATION = read("packages", "db", "migrations", "103-email-campaigns.sql");
  assert.match(MIGRATION, /add column if not exists channel text not null default 'whatsapp'/);
  assert.match(MIGRATION, /check \(channel in \('whatsapp', 'email'\)\)/);
  assert.match(MIGRATION, /alter column template_id drop not null/);
  assert.match(MIGRATION, /broadcasts_channel_content_check/);
  assert.match(MIGRATION, /'paused', 'stopped'\)\)/);
  for (const column of ["to_address", "email_message_id", "send_after", "unsubscribe_token"]) {
    assert.match(MIGRATION, new RegExp(`broadcast_recipients add column if not exists ${column}`));
  }
  assert.match(MIGRATION, /unsubscribe_token uuid not null default gen_random_uuid\(\)/);
  assert.match(MIGRATION, /contacts add column if not exists email_campaigns_opted_out_at/);
  assert.match(MIGRATION, /contacts add column if not exists email_bounced_at/);
  const TYPES = read("packages", "shared", "src", "types.ts");
  assert.match(TYPES, /export type BroadcastChannel = "whatsapp" \| "email"/);
  assert.match(TYPES, /"paused" \| "stopped"/);
});

test("an email audience is people with an address who have not said stop, bounced, or been set aside", () => {
  const DB = read("packages", "db", "src", "email-campaigns.ts");
  const at = DB.indexOf("export function emailReachableSql");
  assert.ok(at >= 0);
  const end = DB.indexOf("export interface EmailAudienceMember", at);
  assert.ok(end > at);
  const rule = DB.slice(at, end);
  for (const part of [
    "email_campaigns_opted_out_at is null",
    "email_bounced_at is null",
    "reengagement_opted_out = false",
    "not_a_customer_at is null",
  ]) {
    assert.ok(rule.includes(part), `the audience rule checks ${part}`);
  }
  // A staff campaign reaches their own book only; both are one row per address.
  const mine = DB.slice(DB.indexOf("export async function myClientsForEmailCampaign"));
  assert.match(mine.slice(0, 900), /contactOwnedBy\("\$2"\)/);
  assert.match(mine.slice(0, 900), /select distinct on/);
});

test("the owner's history shows email campaigns too", () => {
  const BROADCASTS = read("packages", "db", "src", "broadcasts.ts");
  assert.match(BROADCASTS, /left join message_templates t on t\.id = b\.template_id\s+left join broadcast_recipients/);
});

test("a campaign mailbox is the person's own, then the business's — and a business campaign never uses a person's", () => {
  const MAILBOX = read("apps", "api", "src", "services", "campaign-mailbox.ts");
  const ownImap = MAILBOX.indexOf('personal.find((c) => c.provider === "imap"');
  const ownGmail = MAILBOX.indexOf('personal.find((c) => c.provider === "gmail"');
  const businessImap = MAILBOX.indexOf('business.find((c) => c.provider === "imap"');
  assert.ok(ownImap >= 0 && ownGmail > ownImap && businessImap > ownGmail, "own IMAP, own Gmail, business IMAP");
  assert.match(MAILBOX, /const personal = employeeId\s*\?/);
  assert.match(
    MAILBOX,
    /No mailbox to send from — connect yours in Connections, or ask the owner to connect the business mailbox in Channels\./
  );
  const GMAIL = read("apps", "api", "src", "lib", "gmail.ts");
  assert.match(GMAIL, /input\.html \?/);
  assert.match(GMAIL, /multipart\/alternative/);
});

test("subject and message are checked, and refused rather than cut when too long", () => {
  assert.equal(emailContentRefusal("", "hi"), "Write a subject.");
  assert.equal(emailContentRefusal("Hello", "  "), "Write the message.");
  assert.match(emailContentRefusal("x".repeat(201), "hi"), /under 200/);
  assert.match(emailContentRefusal("Hi", "x".repeat(10_001)), /under 10,000/);
  assert.equal(emailContentRefusal("Hi", "Body"), null);
  assert.equal(looksLikeAnEmail("jo@x.com"), true);
  assert.equal(looksLikeAnEmail("not an email"), false);
});

test("a staff member can resume or stop only their own campaign, and a test email writes nothing", () => {
  const STAFF = read("apps", "api", "src", "routes", "my-campaigns.ts");
  assert.match(STAFF, /campaign\.employeeId !== desk\.employeeId \|\| campaign\.organizationId !== desk\.organizationId/);
  const testAt = STAFF.indexOf('myCampaignsRoute.post("/campaigns/email/test"');
  const testEnd = STAFF.indexOf("myCampaignsRoute.post(", testAt + 10);
  assert.ok(testAt >= 0 && testEnd > testAt);
  const testRoute = STAFF.slice(testAt, testEnd);
  assert.doesNotMatch(testRoute, /queueEmailCampaign|createEmailBroadcast/);
  assert.match(testRoute, /takeTestSend\(/);
  assert.match(STAFF, /Keep \{name\} exactly as written/);
  // The admin routes live under /api/broadcasts, which operatorOnly guards at the mount.
  const ADMIN = read("apps", "api", "src", "routes", "broadcasts.ts");
  assert.match(ADMIN, /broadcastsRoute\.post\("\/:slug\/email"/);
  assert.match(ADMIN, /broadcastsRoute\.post\("\/:id\/resume"/);
  assert.match(read("apps", "api", "src", "index.ts"), /app\.use\("\/api\/broadcasts\/\*", operatorOnly\)/);
});

test("the campaign page offers WhatsApp and Email, and says how a list will be paced", () => {
  // Since 30 Oct 2026 bulk sending is the admins' alone: the staff page only
  // says where it went, and the owner's Campaigns page carries both channels.
  const MINE = read("apps", "web", "app", "deck", "my-campaigns", "page.tsx");
  const OWNER = read("apps", "web", "app", "deck", "broadcasts", "page.tsx");
  assert.match(OWNER, /<EmailCampaignForm/);
  assert.match(OWNER, /className="ecf-tabs"/);
  assert.match(OWNER, /<CampaignControls/);
  assert.match(MINE, /Bulk messaging is done by the admins now/);
  assert.doesNotMatch(MINE, /<EmailCampaignForm|sendMyCampaign/);
  const FORM = read("apps", "web", "app", "deck", "my-campaigns", "email-campaign.tsx");
  assert.match(FORM, /`Email \$\{people\(side\.reachable\)\}`/);
  assert.match(FORM, /describePlan\(side\.plan\)/);
  assert.equal(describePlan([61]), "All 61 go out today, a few seconds apart.");
  assert.match(describePlan([300, 120]), /^300 today, 120 tomorrow/);
});
