// An email campaign is personal and polite (26 Oct 2026). The owner: "fix the
// bulk messaging separated for email and whatsapp, be creative and reliable".
// Spec: docs/superpowers/specs/2026-10-26-email-campaigns-design.md
//
// One email per person, their own name in it, an unsubscribe that works in one
// click, a daily pace a mailbox survives, and a bounce that stops the address
// being tried again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  firstName,
  renderCampaignEmail,
  splitByDailyCap,
  classifyEmailSendError,
  explainEmailSendError,
  bounceAddresses,
} from "../src/lib/campaign-email.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

const sample = (over = {}) =>
  renderCampaignEmail({
    subject: "News for {name}",
    body: "Hi {name},\n\nOur sale starts Friday: https://zipicka.com/sale\n\nSee you!",
    displayName: "Ralph Simeon",
    unsubscribeUrl: "https://x/unsubscribe/t",
    businessName: "Zipicka",
    fromAddress: "ralph@zipicka.com",
    ...over,
  });

// ---- the message itself ------------------------------------------------------

test("{name} is the customer's first name, or 'there' when nobody is on file", () => {
  assert.equal(firstName("Ralph Simeon"), "Ralph");
  assert.equal(firstName("  "), "there");
  assert.equal(firstName(null), "there");
  const mail = sample();
  assert.equal(mail.subject, "News for Ralph");
  assert.match(mail.text, /^Hi Ralph,/);
  assert.match(sample({ displayName: null }).text, /^Hi there,/);
});

test("what a customer typed into their name is escaped in the HTML and left alone in the text", () => {
  const mail = sample({ displayName: "<b>Jo&Co</b>", body: "Hello {name}" });
  assert.match(mail.html, /&lt;b&gt;Jo&amp;Co&lt;\/b&gt;/);
  assert.doesNotMatch(mail.html, /<b>Jo/);
  assert.match(mail.text, /Hello <b>Jo&Co<\/b>/);
});

test("every email says how to stop them, in the footer and in the one-click header", () => {
  const mail = sample();
  assert.match(mail.text, /Don't want these emails\? Unsubscribe: https:\/\/x\/unsubscribe\/t$/);
  assert.match(mail.html, /<a href="https:\/\/x\/unsubscribe\/t"[^>]*>Unsubscribe<\/a>/);
  assert.equal(
    mail.headers["List-Unsubscribe"],
    "<https://x/unsubscribe/t>, <mailto:ralph@zipicka.com?subject=unsubscribe>"
  );
  assert.equal(mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
});

test("links in the message can be clicked, and nothing is tracked", () => {
  const mail = sample();
  assert.match(mail.html, /<a href="https:\/\/zipicka\.com\/sale">https:\/\/zipicka\.com\/sale<\/a>/);
  assert.doesNotMatch(mail.html, /<img/);
});

// ---- pace ---------------------------------------------------------------------

test("a list bigger than today's limit finishes on later days instead of being refused", () => {
  assert.deepEqual(splitByDailyCap(61, 0, 300), [61]);
  assert.deepEqual(splitByDailyCap(420, 0, 300), [300, 120]);
  assert.deepEqual(splitByDailyCap(10, 300, 300), [0, 10]);
  assert.deepEqual(splitByDailyCap(650, 100, 300), [200, 300, 150]);
  assert.deepEqual(splitByDailyCap(0, 0, 300), []);
});

// ---- failures -------------------------------------------------------------------

test("a mailbox that will not sign in is told apart from a bad address and from a blip", () => {
  assert.equal(classifyEmailSendError({ responseCode: 535 }), "auth");
  assert.equal(classifyEmailSendError(new Error("GMAIL_RECONNECT revoked")), "auth");
  assert.equal(classifyEmailSendError(new Error("invalid_grant")), "auth");
  assert.equal(classifyEmailSendError({ responseCode: 421 }), "transient");
  assert.equal(classifyEmailSendError({ code: "ETIMEDOUT" }), "transient");
  assert.equal(classifyEmailSendError(new Error("HTTP 503")), "transient");
  assert.equal(classifyEmailSendError({ responseCode: 550 }), "permanent");
  assert.match(explainEmailSendError({ responseCode: 550, message: "550 5.1.1 user unknown" }), /address/i);
});

test("a bounce names the address that failed; a customer's own mail names nobody", () => {
  assert.deepEqual(
    bounceAddresses({
      from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
      subject: "Delivery Status Notification (Failure)",
      body: "Your message wasn't delivered to jo@x.com because the address couldn't be found.",
    }),
    ["jo@x.com"]
  );
  assert.deepEqual(
    bounceAddresses({ from: "Jo <jo@x.com>", subject: "Re: News", body: "write to me at jo@x.com" }),
    []
  );
});

// ---- the send path ------------------------------------------------------------

test("the sender reads the campaign fresh, honours an unsubscribe since queueing, and pauses on a dead mailbox", () => {
  const EMAIL_WORKER = read("apps", "api", "src", "queue", "email-broadcast-processor.ts");
  const read1 = EMAIL_WORKER.indexOf("emailRecipientForSend(");
  const send = EMAIL_WORKER.indexOf("sendFromMailbox(");
  assert.ok(read1 >= 0 && send > read1, "reads the recipient before sending");
  const guard = EMAIL_WORKER.slice(read1, send);
  assert.match(guard, /campaignStatus === "paused" \|\| .*campaignStatus === "stopped"/);
  assert.match(guard, /optedOut/);
  assert.match(guard, /bounced/);
  assert.match(EMAIL_WORKER, /kind === "auth"\) \{\s*await pauseForMailbox\(/);
  assert.match(EMAIL_WORKER, /async function pauseForMailbox[\s\S]{0,300}setBroadcastStatusIf\(broadcastId, \["sending"\], "paused"\)/);
  assert.match(EMAIL_WORKER, /pauseBroadcastIfFailing\(/);
});

test("a WhatsApp campaign never asks Meta to message an empty number", () => {
  const WA_WORKER = read("apps", "api", "src", "queue", "broadcast-processor.ts");
  const guard = WA_WORKER.indexOf("if (!contactWaId");
  const meta = WA_WORKER.indexOf("sendWhatsAppTemplate(");
  assert.ok(guard >= 0 && meta >= 0 && guard < meta, "checked before the send");
});

// ---- unsubscribe and the sweep --------------------------------------------------

test("the unsubscribe page needs no sign-in and says the same thing for any token", () => {
  const route = read("apps", "api", "src", "routes", "unsubscribe.ts");
  assert.doesNotMatch(route, /requireAuth/);
  assert.match(route, /unsubscribeByToken\(/);
  assert.match(route, /c\.req\.query\("t"\)/);
  assert.match(route, /return c\.html\(DONE\)/);
  const index = read("apps", "api", "src", "index.ts");
  assert.match(index, /app\.route\("\/unsubscribe", unsubscribeRoute\)/);
});

test("the inbox sweep reads bounces before skipping automated mail, and an 'unsubscribe' reply opts out", () => {
  const SYNC = read("apps", "api", "src", "services", "email-sync.ts");
  const at = SYNC.indexOf("async function storeInboxMail");
  assert.ok(at >= 0);
  const store = SYNC.slice(at);
  const bounce = store.indexOf("bounceAddresses(");
  const skip = store.indexOf("isAutomatedMail(");
  assert.ok(bounce >= 0, "bounces are read");
  assert.ok(skip < 0 || bounce < skip || store.indexOf(".automated") > bounce, "before automated mail is dropped");
  assert.match(store, /looksLikeAnOptOut\(/);
  assert.match(store, /optOutOfEmailCampaigns\(/);
});
