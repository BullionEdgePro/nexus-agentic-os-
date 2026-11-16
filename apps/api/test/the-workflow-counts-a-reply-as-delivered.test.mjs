// The Workflow page counts a reply as delivered, as Bulk does (16 Nov 2026).
//
// On 13 Nov Bulk learned that a customer's own reply is proof their campaign
// message arrived (a-reply-is-proof-of-delivery). The workflow audit reads the
// same recipients through its own query, and that query was not told: three
// days later the audit of the live site found the Workflow page saying
// "Delivered 4" for the SFS campaign beside Bulk's 17. One campaign, one
// business, two screens, two answers.
//
// Both now read who has written in through one shared piece of SQL
// (customersWhoWrote in packages/db/src/broadcasts.ts), and this test holds the
// two figures to each other, so the next change to the rule cannot move one
// screen and leave the other behind.
//
// Takes its turn at the shared test database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "95959595-0000-4000-8000-000000000001";
const NUMBER = "980001";
const person = (n) => `95959595-0000-4000-8000-0000000000a${n}`;

let owner;
let dbTurn;
let lib;
let campaign;

const recipient = (n, status) =>
  owner.query(
    `insert into broadcast_recipients (broadcast_id, contact_id, status, sent_at, wa_message_id)
     values ($1, $2, $3, now() - interval '1 hour', $4)`,
    [campaign, person(n), status, `wamid.audit.${n}`]
  );

/** The customer writes to the business's number, this long ago. */
const wrote = async (n, ago) => {
  const conversation = (
    await owner.query(`insert into conversations (organization_id, contact_id) values ($1, $2) returning id`, [ORG, person(n)])
  ).rows[0].id;
  await owner.query(
    `insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, created_at)
     values ($1, $2, $3, 'inbound', 'contact', 'Is it still available?', now() - $4::interval)`,
    [ORG, conversation, person(n), ago]
  );
};

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone, is_number_owner)
     values ($1, 'reply-proof-audit', 'Proof Estates', $2, '880001', 'Asia/Dubai', true)`,
    [ORG, NUMBER]
  );
  for (let n = 1; n <= 4; n++) {
    await owner.query(`insert into contacts (id, organization_id, wa_id, channel, display_name) values ($1, $2, $3, 'whatsapp', $4)`, [
      person(n),
      ORG,
      `97159800010${n}`,
      `Customer ${n}`,
    ]);
  }
  const template = (
    await owner.query(
      `insert into message_templates (organization_id, meta_template_name, language, status, is_approved, body_param_count)
       values ($1, 'bulk_audit_new_homes', 'en', 'APPROVED', true, 0) returning id`,
      [ORG]
    )
  ).rows[0].id;
  campaign = (
    await owner.query(
      `insert into broadcasts (organization_id, template_id, status, from_phone_number_id, audience_filter, created_at)
       values ($1, $2, 'completed', $3, '{"scope":"admin-bulk"}', now() - interval '2 hours') returning id`,
      [ORG, template, NUMBER]
    )
  ).rows[0].id;

  await recipient(1, "sent"); // answered the campaign
  await wrote(1, "40 minutes");
  await recipient(2, "sent"); // silent
  await recipient(3, "delivered"); // Meta sent a receipt
  await recipient(4, "failed"); // refused by Meta; wrote in about something else
  await wrote(4, "30 minutes");

  process.env.DATABASE_URL = APP_URL;
  lib = await import("@nexus/db");
});

after(async () => {
  if (db.skip) return;
  try {
    await owner.query(`delete from messages where organization_id = $1`, [ORG]);
    await owner.query(`delete from conversations where organization_id = $1`, [ORG]);
    await owner.query(`delete from broadcast_recipients where broadcast_id in (select id from broadcasts where organization_id = $1)`, [ORG]);
    await owner.query(`delete from broadcasts where organization_id = $1`, [ORG]);
    await owner.query(`delete from message_templates where organization_id = $1`, [ORG]);
    await owner.query(`delete from contacts where organization_id = $1`, [ORG]);
    await owner.query(`delete from organizations where id = $1`, [ORG]);
  } finally {
    if (dbTurn) {
      await dbTurn.query("select pg_advisory_unlock(20261102)");
      dbTurn.release();
    }
    await owner?.end();
    if (lib) await lib.getPool().end();
  }
});

const audit = () =>
  lib.getWorkflowAudit({ organizationId: ORG, slug: "reply-proof-audit", name: "Proof Estates", timezone: "Asia/Dubai", days: 7 });

test("the Workflow page counts the customer who answered, beside the one Meta confirmed", db, async () => {
  const { outreach } = (await audit()).evidence;
  assert.equal(outreach.sent, 3, "accepted by WhatsApp: everyone but the refused one");
  assert.equal(outreach.failed, 1, "a refused message stays refused, whatever the customer wrote");
  // Customer 3 by receipt, customer 1 by their own reply — not 2 (silent) or 4 (refused).
  assert.equal(outreach.delivered, 2);
});

test("the Workflow page and Bulk give one answer for the same campaign", db, async () => {
  const { outreach } = (await audit()).evidence;
  const [sent] = await lib.withTenant(ORG, () => lib.listBroadcasts(ORG));
  assert.equal(sent.id, campaign);
  assert.deepEqual(
    { sent: outreach.sent, delivered: outreach.delivered, failed: outreach.failed },
    { sent: sent.sent, delivered: sent.delivered, failed: sent.failed }
  );
});
