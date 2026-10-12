// A newsletter says it is one, and the business mailbox now listens.
//
// FOUND 12 OCT 2026. The automation filter keys on List-Unsubscribe and List-Id,
// the headers every legitimate bulk sender sets. The business mailbox (IMAP)
// read them with `parsed.headers.get("list-unsubscribe")` — but mailparser does
// not keep List-* headers under their own names: it folds them into one `list`
// object. So the lookup was always empty and every properly-marked newsletter
// (Canva, AliExpress, Amazon, Cision) walked into the inbox and stood as an
// urgent "customer waiting". Run against the real parser, not a mock of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { simpleParser } from "mailparser";
import { automationHeaders } from "../src/lib/imap-email.ts";
import { isAutomatedMail } from "../src/lib/mail-filter.ts";

const raw = (...headers) =>
  Buffer.from([...headers, "From: Canva <canvaworldtour@engage.canva.com>", "To: info@example.com", "Subject: hi", "", "body"].join("\r\n"));

test("a List-Unsubscribe header reaches the filter, and the mail is set aside", async () => {
  const parsed = await simpleParser(raw("List-Unsubscribe: <https://x.example/u>, <mailto:u@x.example>"));
  const headers = automationHeaders(parsed.headers);
  assert.ok(headers["list-unsubscribe"], "the header survived mailparser's folding");
  assert.equal(isAutomatedMail({ from: "canvaworldtour@engage.canva.com", headers }), true);
});

test("a List-Id header alone is enough", async () => {
  const parsed = await simpleParser(raw("List-Id: Canva news <news.canva.com>"));
  assert.equal(isAutomatedMail({ from: "x@engage.canva.com", headers: automationHeaders(parsed.headers) }), true);
});

test("Precedence and Auto-Submitted still arrive under their own names", async () => {
  const bulk = await simpleParser(raw("Precedence: bulk"));
  assert.equal(automationHeaders(bulk.headers).precedence, "bulk");
  const auto = await simpleParser(raw("Auto-Submitted: auto-replied"));
  assert.equal(automationHeaders(auto.headers)["auto-submitted"], "auto-replied");
});

test("a person's own email is not set aside", async () => {
  const parsed = await simpleParser(raw());
  assert.equal(isAutomatedMail({ from: "fashrin.official@gmail.com", headers: automationHeaders(parsed.headers) }), false);
});
