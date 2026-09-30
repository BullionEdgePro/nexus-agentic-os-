// Business email: before 2026-09-30 a connected mailbox only imported mail from
// customers who already had an email address saved — none did, so not one
// email ever reached the inbox. Now every email from a PERSON arrives; automated
// mail is kept out. The filter runs for real; the wiring is pinned as text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { isAutomatedMail, emailsIn, senderName } from "../src/lib/mail-filter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8").replace(/\r\n/g, "\n");
const SYNC = read("apps", "api", "src", "services", "email-sync.ts");
const IMAP = read("apps", "api", "src", "lib", "imap-email.ts");
const DB = read("packages", "db", "src", "email-sync.ts");
const CONNS = read("packages", "db", "src", "social-connections.ts");
const CHANNELS = read("apps", "api", "src", "routes", "channels.ts");

test("a person's email is let in", () => {
  assert.equal(isAutomatedMail({ from: "ahmed.k@outlook.com" }), false);
  assert.equal(isAutomatedMail({ from: "sara@lawfirm.ae", headers: { "Auto-Submitted": "no" } }), false);
  // A small business's marketing@ or info@ address is usually a person.
  assert.equal(isAutomatedMail({ from: "marketing@zipicka.com" }), false);
  assert.equal(isAutomatedMail({ from: "info@realestate.ae" }), false);
});

test("newsletters, bulk, no-reply and auto-replies are kept out", () => {
  assert.equal(isAutomatedMail({ from: "news@shop.com", headers: { "List-Unsubscribe": "<mailto:u@shop.com>" } }), true);
  assert.equal(isAutomatedMail({ from: "a@b.com", headers: { "list-id": "<team.b.com>" } }), true);
  assert.equal(isAutomatedMail({ from: "a@b.com", headers: { Precedence: "bulk" } }), true);
  assert.equal(isAutomatedMail({ from: "a@b.com", headers: { "Auto-Submitted": "auto-replied" } }), true);
  for (const from of ["noreply@x.com", "no-reply@x.com", "do-not-reply@x.com", "mailer-daemon@x.com", "notifications@github.com", "newsletter@x.com"]) {
    assert.equal(isAutomatedMail({ from }), true, from);
  }
  // Narrow on purpose: an address that merely CONTAINS a role word is a person.
  assert.equal(isAutomatedMail({ from: "alerts.team.lead@x.com" }), true);
  assert.equal(isAutomatedMail({ from: "noreplyhero@x.com" }), false);
});

test("sender name and address are read from a From header", () => {
  assert.deepEqual(emailsIn('"Ada Lovelace" <Ada@Example.com>'), ["ada@example.com"]);
  assert.equal(senderName('"Ada Lovelace" <ada@example.com>'), "Ada Lovelace");
  assert.equal(senderName("ada@example.com"), null);
});

test("the sync reads recent mail, not only customers already on file", () => {
  assert.ok(!/clientContactsWithEmail/.test(SYNC), "the on-file-only lookup is gone from the sync");
  assert.match(SYNC, /fetchRecentMailImap\(credential\.email, credential\.password, \{ sinceDays: 3, limit: 40 \}\)/);
  assert.match(SYNC, /fetchRecentInboxMailFull\(accessToken, 40\)/);
  const store = SYNC.slice(SYNC.indexOf("async function storeInboxMail("));
  const loop = store.slice(0, store.indexOf("return { newMessages, threads: touched.size, skippedAutomated };"));
  assert.match(loop, /if \(!fromEmail \|\| fromEmail === ownerAddress\) continue;/);
  assert.match(loop, /if \(m\.automated\) \{/);
  assert.match(loop, /findOrCreateEmailContact\(/);
});

test("a new sender becomes a customer with their address saved for replies", () => {
  const fn = DB.slice(DB.indexOf("export async function findOrCreateEmailContact("));
  assert.match(fn, /lower\(ct\.attributes->>'email'\) = \$2/, "a customer already on file with that address is reused");
  assert.match(fn, /values \(\$1, 'email', \$2, \$3, jsonb_build_object\('email', \$2::text\), \$4::uuid, now\(\)\)/);
  assert.match(fn, /on conflict \(organization_id, channel, external_id\) where external_id is not null/);
});

test("Gmail connects over IMAP with an app password, and business mailboxes sync", () => {
  assert.match(IMAP, /isGoogle\(email\) \? "imap\.gmail\.com"/);
  assert.match(IMAP, /isGoogle\(email\) \? "smtp\.gmail\.com"/);
  const list = CONNS.slice(CONNS.indexOf("export async function listImapConnectionsForSync("));
  assert.ok(!/and employee_id is not null/.test(list.slice(0, list.indexOf("return rows"))), "business mailboxes were filtered out");
  // Only the owner connects one, and the password is proven before it is saved.
  const post = CHANNELS.slice(CHANNELS.indexOf('channelsRoute.post("/mailboxes"'));
  assert.ok(post.indexOf("await verifyImapLogin(email, password)") < post.indexOf("saveConnection("));
  assert.match(post, /employeeId: null,/);
});

test("a reply to a business-mailbox customer leaves from that mailbox", () => {
  const send = SYNC.slice(SYNC.indexOf("export async function sendEmailReply("));
  assert.match(send, /listConnections\(owner\.organizationId, null\)/);
  assert.match(send, /const imapConn = personalImap \?\? businessImap;/);
  assert.ok(!/is not owned by a staff member, so there is no mailbox/.test(send));
});
