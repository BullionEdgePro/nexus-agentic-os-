// One customer, one campaign message (audit, 4 Nov 2026).
//
// The same person can be two contact rows that one business serves: one made
// under the old shared line's owner (Bulk's "+ Add numbers", or the shared-line
// days) and one made when they later wrote to an admin's number in the business
// itself. Bulk listed both, ticking all sent the campaign twice, and a STOP on
// one row left the other being messaged. Now the audience is one row per number
// (the business's own row first), a STOP on any row the business can see takes
// that number out of it, and the send job — which sees every business — refuses
// a number anyone was told to leave alone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const LINE_OWNER = "96969696-0000-4000-8000-000000000001";
const BUSINESS = "96969696-0000-4000-8000-000000000002";
const TWIN_UNDER_OWNER = "96969696-0000-4000-8000-0000000000c1";
const TWIN_OWN = "96969696-0000-4000-8000-0000000000c2";
const SOMEONE_ELSE = "96969696-0000-4000-8000-0000000000c3";
const SAME_PERSON = "971598000301";

let owner;
let dbTurn;
let lib;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_number_owner)
     values ($1, 'twin-owner', 'Line Owner', '960301', '860301', 'Asia/Dubai', true),
            ($2, 'twin-business', 'Twin Business', '960301', '860301', 'Asia/Dubai', false)`,
    [LINE_OWNER, BUSINESS]
  );
  await owner.query(
    `insert into contacts (id, organization_id, served_organization_ids, wa_id, channel, display_name, created_at)
     values ($1, $4, array[$5]::uuid[], $6, 'whatsapp', 'Sara (shared-line days)', now() - interval '30 days'),
            ($2, $5, '{}', $6, 'whatsapp', 'Sara', now()),
            ($3, $5, '{}', '971598000302', 'whatsapp', 'Omar', now())`,
    [TWIN_UNDER_OWNER, TWIN_OWN, SOMEONE_ELSE, LINE_OWNER, BUSINESS, SAME_PERSON]
  );
  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(`delete from broadcast_recipients where broadcast_id in (select id from broadcasts where organization_id = $1)`, [BUSINESS]);
    await owner.query(`delete from broadcasts where organization_id = $1`, [BUSINESS]);
    await owner.query(`delete from message_templates where organization_id = $1`, [BUSINESS]);
    await owner.query(`delete from contacts where organization_id in ($1, $2)`, [LINE_OWNER, BUSINESS]);
    await owner.query(`delete from organizations where id in ($1, $2)`, [LINE_OWNER, BUSINESS]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    await lib?.getPool().end();
  }
});

const audience = () => lib.withTenant(BUSINESS, () => lib.getContactsForAudience(BUSINESS, {}));

test("a person who is two rows is one recipient, and the business's own row is the one", db, async () => {
  const people = await audience();
  const sara = people.filter((person) => person.waId === SAME_PERSON);
  assert.equal(sara.length, 1, "the same number would be messaged twice");
  assert.equal(sara[0].id, TWIN_OWN);
  assert.ok(people.some((person) => person.id === SOMEONE_ELSE));
});

test("a STOP on either row takes the number out of the audience", db, async () => {
  await owner.query(`update contacts set reengagement_opted_out = true where id = $1`, [TWIN_UNDER_OWNER]);
  try {
    assert.ok(
      !(await audience()).some((person) => person.waId === SAME_PERSON),
      "the twin of someone who said STOP was still in the audience"
    );
  } finally {
    await owner.query(`update contacts set reengagement_opted_out = false where id = $1`, [TWIN_UNDER_OWNER]);
  }
});

test("the send job refuses a number anyone was told to leave alone, whichever row it was queued for", db, async () => {
  const template = (
    await owner.query(
      `insert into message_templates (organization_id, meta_template_name, language, status, is_approved, body_param_count)
       values ($1, 'twin_probe', 'en', 'APPROVED', true, 1) returning id`,
      [BUSINESS]
    )
  ).rows[0].id;
  const broadcast = (
    await owner.query(
      `insert into broadcasts (organization_id, template_id, status, from_phone_number_id, audience_filter)
       values ($1, $2, 'sending', '960301', '{"scope":"admin-bulk"}') returning id`,
      [BUSINESS, template]
    )
  ).rows[0].id;
  const recipient = (
    await owner.query(`insert into broadcast_recipients (broadcast_id, contact_id, status) values ($1, $2, 'pending') returning id`, [
      broadcast,
      TWIN_UNDER_OWNER,
    ])
  ).rows[0].id;
  await owner.query(`update contacts set reengagement_opted_out = true where id = $1`, [TWIN_OWN]);
  try {
    const found = await lib.withAllTenants("test: as the send job reads it", () => lib.recipientForSend(recipient));
    assert.equal(found?.optedOut, true, "the row that was queued would still be messaged");
  } finally {
    await owner.query(`update contacts set reengagement_opted_out = false where id = $1`, [TWIN_OWN]);
  }
});

test("a chat on the business's own number is inside the 24-hour window when they wrote an hour ago", db, async () => {
  // Business-number chats are recorded unpinned (phone_number_id null); the
  // window check matched only pinned chats, so every reply on a business's own
  // live number would have been refused as "outside 24 hours" (review, 4 Nov 2026).
  const conversation = (
    await owner.query(
      `insert into conversations (organization_id, contact_id, channel) values ($1, $2, 'whatsapp') returning id`,
      [BUSINESS, SOMEONE_ELSE]
    )
  ).rows[0].id;
  await owner.query(
    `insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, status, created_at)
     values ($1, $2, $3, 'inbound', 'contact', 'Hello', 'delivered', now() - interval '1 hour')`,
    [BUSINESS, conversation, SOMEONE_ELSE]
  );
  try {
    const open = await lib.withTenant(BUSINESS, () => lib.openWindowConversations(BUSINESS, "960301", [SOMEONE_ELSE]));
    assert.equal(open[0]?.conversationId, conversation, "a fresh chat on the business's own number read as closed");
  } finally {
    await owner.query(`delete from messages where conversation_id = $1`, [conversation]);
    await owner.query(`delete from conversations where id = $1`, [conversation]);
  }
});

test("ticking a person's other row still chooses them, as the one row the list shows", db, async () => {
  // Bulk's "+ Add numbers" answers with the row it made under the line's owner,
  // and the page ticks that id; the list now shows the business's own row, so
  // the tick matched nothing and the person was silently left out (review).
  const chosen = await lib.withTenant(BUSINESS, () => lib.chosenAudience(BUSINESS, [TWIN_UNDER_OWNER]));
  assert.deepEqual(chosen.map((person) => person.id), [TWIN_OWN]);
});
