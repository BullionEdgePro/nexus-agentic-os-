// A contact identified by something other than a phone.
//
// The Facebook Page and Instagram channels cannot store a sender: a contact WAS
// a WhatsApp number (`wa_id NOT NULL`, the sole identity), and a Messenger PSID
// or an Instagram IGSID is not a phone. Slice 2 gives a contact a second,
// channel-scoped identity WITHOUT disturbing the WhatsApp one every existing row
// and query leans on.
//
// The interesting decisions are in the SQL — whether the change is additive
// (does an existing WhatsApp contact still resolve exactly as before?) and
// whether the new path can create a row no channel can reach — so this pins the
// migration and the resolver as text, the way the rest of the identity suite does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const MIGRATION = read("packages", "db", "migrations", "088-a-contact-need-not-have-a-phone.sql");
const SCHEMA = read("packages", "db", "schema.sql");
const RESOLVER = read("packages", "db", "src", "social-identity.ts");
const MESSAGES = read("packages", "db", "src", "messages.ts");
const CONTACT_IDENTITY = read("packages", "db", "src", "contact-identity.ts");

test("wa_id stops being mandatory, so a contact can exist without a phone", () => {
  assert.match(
    MIGRATION,
    /alter\s+column\s+wa_id\s+drop\s+not\s+null/i,
    "a Messenger/Instagram/email contact has no wa_id; it must be allowed to be null"
  );
  // The schema-of-record agrees, or the next hand-built database is born wrong.
  assert.match(SCHEMA, /wa_id\s+text,/i, "schema.sql must show wa_id as nullable");
});

test("the WhatsApp identity is left exactly as it was — the change is additive", () => {
  // The old unique(organization_id, wa_id) is KEPT: NULLs are distinct, so it
  // still enforces one row per number while permitting rows with no number. If a
  // migration ever DROPPED it, every WhatsApp upsert's on-conflict arbiter would
  // vanish and inbound would start duplicating contacts.
  assert.doesNotMatch(
    MIGRATION,
    /drop\s+constraint[^;]*wa_id|drop\s+constraint\s+contacts_organization_id_wa_id_key/i,
    "the wa_id uniqueness must survive this migration untouched"
  );
  assert.match(SCHEMA, /unique\s*\(organization_id,\s*wa_id\)/i);

  // Proof the WhatsApp writers were not touched: all three still resolve on the
  // very same key, so existing behaviour is unchanged.
  const waConflicts = (s) => (s.match(/on conflict \(organization_id, wa_id\)/g) || []).length;
  assert.equal(waConflicts(MESSAGES), 2, "both message-path upserts still key on wa_id");
  assert.equal(waConflicts(CONTACT_IDENTITY), 1, "the hand-capture upsert still keys on wa_id");
});

test("the new identity is one row per business per channel", () => {
  assert.match(
    MIGRATION,
    /create\s+unique\s+index[\s\S]*on\s+contacts\s*\(organization_id,\s*channel,\s*external_id\)[\s\S]*where\s+external_id\s+is\s+not\s+null/i,
    "a PSID and an IGSID that happen to be equal are different people; the index must include channel and stay off WhatsApp rows"
  );
});

test("no contact can exist that no channel can reach", () => {
  assert.match(
    MIGRATION,
    /check\s*\(\s*wa_id\s+is\s+not\s+null\s+or\s+external_id\s+is\s+not\s+null\s*\)/i,
    "every contact must carry at least one identity"
  );
});

test("the resolver settles who the person is, on the external identity, without inventing a phone", () => {
  assert.match(
    RESOLVER,
    /on conflict \(organization_id, channel, external_id\) where external_id is not null/,
    "the resolver must upsert on the new identity, not the WhatsApp key"
  );
  // It inserts channel + external_id, and never a wa_id — this person is known by
  // their channel id, and the has-identity check is satisfied by external_id.
  assert.match(RESOLVER, /insert into contacts \(organization_id, channel, external_id/);
  assert.doesNotMatch(RESOLVER, /insert into contacts[^)]*wa_id/, "the resolver must not write a wa_id");
});

test("a name already on file is never blanked by a later, nameless message", () => {
  assert.match(
    RESOLVER,
    /display_name\s*=\s*coalesce\(contacts\.display_name,\s*excluded\.display_name\)/,
    "an incoming blank name must not erase a known one — same rule as the WhatsApp path"
  );
});

test("an empty external id is refused rather than written as an unreachable row", () => {
  assert.match(RESOLVER, /if \(!externalId\)/);
  assert.match(RESOLVER, /throw new Error/);
});
