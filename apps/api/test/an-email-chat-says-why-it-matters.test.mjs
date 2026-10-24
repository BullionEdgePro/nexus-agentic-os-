// An email chat says why it matters, like a WhatsApp one (24 Oct 2026).
//
// Found checking the Focus workspace as Ralph: 71 of his 73 chats had no lead
// assessment — they were email, and only the WhatsApp pipeline ever scored a
// message — so My queue's reason tags were blank where they mattered most.
// Owner: "score incoming email chats the same way as WhatsApp so every chat in
// the queue shows its reason tag."
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { freshPartOfEmail } from "../src/lib/mail-filter.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const read = (...p) => readFileSync(join(root, ...p), "utf8");

test("only the new part of an email is scored, not the history quoted under it", () => {
  const body =
    "Do you supply in large quantities?\n\nOn Sat, Oct 18, 2026 at 5:25 PM Zipicka <marketing@zipicka.com> wrote:\n> Thanks for your order, it ships tomorrow.\n> Regards";
  assert.equal(freshPartOfEmail(body), "Do you supply in large quantities?");
  assert.equal(freshPartOfEmail("> only a quote\n> nothing new"), "");
  assert.equal(freshPartOfEmail("Hi there\n-----Original Message-----\nFrom: someone"), "Hi there");
  assert.equal(freshPartOfEmail("x".repeat(5000)).length, 2000, "capped");
});

test("a new email from a person is scored as it arrives; platform mail is not", () => {
  const SYNC = read("apps", "api", "src", "services", "email-sync.ts");
  const store = SYNC.slice(SYNC.indexOf("async function storeInboxMail"));
  assert.ok(SYNC.indexOf("async function storeInboxMail") >= 0, "the mail store exists");
  const body = store.slice(0, store.indexOf("\n}\n"));
  assert.match(body, /if \(inserted && !isPlatformSender\(fromEmail\)\)/);
  assert.match(body, /scoreLead\(\{ text: fresh/);
  assert.match(body, /recordLeadAssessment\(/);
});

test("every scored chat shows a reason, the plain question included", () => {
  assert.match(read("apps", "web", "app", "inbox", "page.tsx"), /general_inquiry: \{ label: "Question", tone: "plain" \}/);
});
