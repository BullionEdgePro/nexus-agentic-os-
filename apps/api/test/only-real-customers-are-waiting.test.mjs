// Only real customers are "waiting".
//
// FOUND 24 OCT 2026 reading Staff work's waiting list: Ralph's business
// mailbox counted Shopify order digests, noon promotions, Amazon and Google
// account mail, Carrefour Marketplace notices and an endless variety of cold
// pitches as customers kept waiting — while four real customers (an order
// cancellation, a UAE shipping question, a bulk enquiry, a US purchase) sat
// among them for weeks. Two fixes, both the owner's:
//
//   - mail from a known platform is marked "not a customer" as it arrives.
//     Kept VISIBLE, not dropped: Amazon's disbursement-appeals mail about the
//     account's funds is in there, and it must still be readable.
//   - one tap, "Not a customer", marks any sender — the pitches no phrase list
//     will ever finish catching, and the lookalike "Shopify" sending from Gmail.
//
// A marked sender is out of every waiting count — the inbox's Awaiting and SLA
// folders, the customer-waiting alert, Staff work — even when they write again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { isPlatformSender } from "../src/lib/platform-senders.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("the platforms' own domains are recognised, subdomains included", () => {
  for (const address of [
    "mailer@shopify.com",
    "email@email.shopify.com",
    "marketing@promo.noon.com",
    "disbursement-appeals@amazon.ae",
    "seller-notification@amazon.com",
    "no-reply@accounts.google.com",
    "cloud-noreply@google.com",
    "sellercom@carrefourmarketplace.majidalfuttaim.com",
  ]) {
    assert.equal(isPlatformSender(address), true, address);
  }
});

test("a person, a lookalike domain or a fake on Gmail is not a platform", () => {
  for (const address of [
    "mailer.merchant.alart@gmail.com", // "Shopify" phishing from Gmail — the button's job, not this rule's
    "fashrin.official@gmail.com",
    "support@notshopify.com",
    "help@amazon-seller.support",
    "shopify.partner@outlook.com",
    "",
  ]) {
    assert.equal(isPlatformSender(address), false, address);
  }
});

test("a contact carries when, why and by whom it was marked", () => {
  const sql = read("packages", "db", "migrations", "100-not-a-customer.sql");
  assert.match(sql, /not_a_customer_at timestamptz/);
  assert.match(sql, /not_a_customer_reason/);
  assert.match(sql, /not_a_customer_by/);
});

test("platform mail is marked as it arrives, and kept", () => {
  const SYNC = read("apps", "api", "src", "services", "email-sync.ts");
  const store = SYNC.slice(SYNC.indexOf("async function storeInboxMail"));
  const body = store.slice(0, store.indexOf("\n}\n"));
  assert.match(body, /isPlatformSender\(fromEmail\)/);
  assert.match(body, /markNotACustomer\(contactId, "platform"/);
  assert.ok(body.indexOf("insertSyncedEmailMessage(") < body.indexOf("markNotACustomer("), "the message is stored first");
});

test("one tap marks a sender and closes the chat; undo clears it", () => {
  const ROUTE = read("apps", "api", "src", "routes", "conversations.ts");
  assert.match(ROUTE, /conversationsRoute\.post\("\/:id\/not-a-customer"/);
  assert.match(ROUTE, /conversationsRoute\.delete\("\/:id\/not-a-customer"/);
  const post = ROUTE.slice(ROUTE.indexOf('conversationsRoute.post("/:id/not-a-customer"'));
  const postBody = post.slice(0, post.indexOf("\n});"));
  assert.match(postBody, /markNotACustomer\(conversation\.contactId, "marked"/);
  assert.match(postBody, /setConversationStatus\(conversationId, "resolved"/);
});

test("every waiting count leaves a marked sender out", () => {
  assert.match(read("apps", "api", "src", "services", "operators.ts"), /ct\.not_a_customer_at is null/);
  const STAFF = read("packages", "db", "src", "staff-work.ts");
  assert.ok((STAFF.match(/not_a_customer_at is null/g) ?? []).length >= 2, "waiting and unowned both");
  const CONV = read("packages", "db", "src", "conversations.ts");
  assert.match(CONV, /ct\.not_a_customer_at is not null as not_a_customer/);
  const INBOX = read("apps", "web", "app", "inbox", "page.tsx");
  assert.match(INBOX, /c\.lastMessageDirection === "inbound" && !c\.notACustomer/);
  assert.match(INBOX, /if \(c\.notACustomer\) return false;/);
});

test("FOUND ON SCREEN: a marked sender's chat shows no 'response delayed' banner", () => {
  const INBOX = read("apps", "web", "app", "inbox", "page.tsx");
  assert.match(INBOX, /activeConversation\?\.lastMessageDirection === "inbound" &&\s*!activeConversation\.notACustomer/);
});
