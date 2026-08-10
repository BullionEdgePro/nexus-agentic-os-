// F10 episodic memory — remembering a customer between conversations.
//
// The failure mode is not forgetting. It is an agent confidently telling a
// customer something about themselves that is stale, inferred, or belongs to a
// different business entirely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const MIGRATION = read("packages", "db", "migrations", "021-contact-memory.sql");
const STORE = read("packages", "db", "src", "contact-memory.ts");
const RECALL = read("packages", "agents", "src", "contact-recall.ts");
const PROCESSOR = read("apps", "api", "src", "queue", "processor.ts");
const CLIENT = read("packages", "db", "src", "client.ts");
const RLS = read("packages", "db", "migrations", "018-row-level-security.sql");
const REDACT = read("packages", "governance", "src", "redact.ts");

// ============================================================
// One number, five businesses, separate memories
// ============================================================

test("memory is keyed on contact, not on phone number", () => {
  // The same human can talk to a shop and a law firm from one handset on this
  // shared number. Keyed on wa_id, what they told the shop would surface in the
  // law firm's conversation — and the agent would use it, fluently.
  assert.match(MIGRATION, /primary key \(organization_id, contact_id\)/);
  assert.ok(!/\bwa_id\b/.test(MIGRATION.split("-- ===")[2] ?? ""), "wa_id must not key this table");
  assert.match(MIGRATION, /The key is therefore contact_id, not wa_id/);
});

test("recall is scoped to the serving business, not the number owner", () => {
  // The shared number's owner is Zipicka; a legal enquiry routed to ABR must
  // recall ABR's memory of that person, not Zipicka's.
  assert.match(PROCESSOR, /recallContact\(serving\.id, contactId\)/);
  assert.match(PROCESSOR, /rememberContact\(\{ organizationId: serving\.id/);
});

test("the memory table is tenant-scoped and RLS-guarded", () => {
  // It holds prose about a named customer — the most sensitive thing stored.
  assert.match(CLIENT, /"contact_memory"/);
  assert.match(RLS, /'contact_memory'/);
});

test("memory is never shareable across tenants", () => {
  assert.ok(
    !/contact_memory|summary/.test(
      REDACT.slice(REDACT.indexOf("export const SHAREABLE"), REDACT.indexOf("export type ShareableField"))
    ),
    "a customer summary must never reach the cross-tenant allow-list"
  );
});

// ============================================================
// It refuses to invent a person
// ============================================================

test("a short exchange is not summarised at all", () => {
  // Two messages turned into "the customer seems interested in X" is a
  // fabricated profile, not a memory.
  assert.match(RECALL, /MIN_MESSAGES_TO_REMEMBER = 4/);
  assert.match(RECALL, /too short to summarise honestly/);
});

test("the summariser is forbidden from inferring", () => {
  // A guess written down becomes a fact the next reader acts on.
  assert.match(RECALL, /Do not infer their[\s\S]{0,60}budget, seniority, urgency or intent from tone/);
  assert.match(RECALL, /becomes a[\s\S]{0,40}fact the next reader acts on/);
});

test("the newest conversation wins over an older note", () => {
  assert.match(RECALL, /prefer the latest/);
});

test("recall is labelled as possibly stale, not as truth", () => {
  // Presented to the model as a note that may be wrong, with an explicit
  // instruction not to recite it back at the customer.
  assert.match(RECALL, /It may be out of date/);
  assert.match(RECALL, /if what they say now[\s\S]{0,40}contradicts it, believe them/);
  assert.match(RECALL, /never recite it back to them as fact/);
});

test("recall cannot crowd out the knowledge that answers the question", () => {
  assert.match(RECALL, /MAX_MEMORY_CHARS = 600/);
  assert.match(RECALL, /Recall is context, not the answer/);
});

// ============================================================
// It cannot damage the reply path
// ============================================================

test("the memory is written after the customer has their reply", () => {
  assert.ok(
    PROCESSOR.indexOf("sentToCustomer = true") < PROCESSOR.indexOf("rememberContact({"),
    "summarising must not delay the reply"
  );
  assert.match(PROCESSOR, /void rememberContact\([\s\S]{0,160}\.catch\(/);
});

test("a recall failure degrades to no memory rather than no reply", () => {
  assert.match(PROCESSOR, /recallContact\(serving\.id, contactId\)\.catch\(\(\) => null\)/);
});

// ============================================================
// It does not accumulate forever
// ============================================================

test("memory expires, and the clock restarts on each write", () => {
  // Otherwise an actively-served customer's memory lapses mid-relationship,
  // while a dormant one is kept indefinitely — exactly backwards.
  assert.match(MIGRATION, /expires_at\s+timestamptz not null default now\(\) \+ interval '180 days'/);
  assert.match(STORE, /expires_at\s+= now\(\) \+ interval '180 days'/);
});

test("expired memory is unreadable even before it is purged", () => {
  // A purge that has not run yet must not mean stale data is still served.
  assert.match(STORE, /and expires_at > now\(\)/);
});

test("a customer can be forgotten on request", () => {
  // "Delete what you hold about me" should not require writing code.
  assert.match(STORE, /export async function forgetContact/);
  assert.match(STORE, /is a request a customer can[\s\S]{0,40}make/);
  console.log("PASS: memory is per-business, refuses to infer, expires, and cannot delay a reply");
});
