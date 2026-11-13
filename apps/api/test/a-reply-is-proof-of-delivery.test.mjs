// A reply is proof of delivery (13 Nov 2026).
//
// The first SFS campaign went to 207 customers on 12 Nov. WhatsApp accepted 152
// and its own dashboard counted 150 delivered -- but it pushed Nexus only FOUR
// "delivered" receipts for that number, so the Bulk page said "Delivered 4"
// while nine customers were already replying to the message. The owner asked,
// twice, why the count was so low.
//
// `delivered` on a campaign is "we know it arrived". A receipt is one way of
// knowing; the customer answering on that same number afterwards is another, and
// a better one. So a recipient still at 'sent' who has written to the campaign's
// number since their send counts as delivered. Nothing is rewritten: the row
// keeps what Meta's receipts said, and the count is worked out when it is read,
// so it is right for campaigns already sent.
//
// Takes its turn at the shared test database.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const ORG = "94949494-0000-4000-8000-000000000001";
const NUMBER = "970001"; // the number the campaign went out from
const OTHER_NUMBER = "970002"; // a colleague's line in the same business
const person = (n) => `94949494-0000-4000-8000-0000000000a${n}`;

let owner;
let dbTurn;
let lib;
let campaign;

/** One recipient of the campaign, sent an hour ago unless told otherwise. */
const recipient = (n, status) =>
  owner.query(
    `insert into broadcast_recipients (broadcast_id, contact_id, status, sent_at, wa_message_id)
     values ($1, $2, $3, now() - interval '1 hour', $4)`,
    [campaign, person(n), status, `wamid.proof.${n}`]
  );

/** The customer writes in: on which number, and how long ago. */
const wrote = async (n, onNumber, ago) => {
  const conversation = (
    await owner.query(
      `insert into conversations (organization_id, contact_id, phone_number_id) values ($1, $2, $3) returning id`,
      [ORG, person(n), onNumber]
    )
  ).rows[0].id;
  await owner.query(
    `insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, created_at)
     values ($1, $2, $3, 'inbound', 'contact', 'Yes please', now() - $4::interval)`,
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
     values ($1, 'proof-org', 'Proof Homes', $2, '870001', 'Asia/Dubai', true)`,
    [ORG, NUMBER]
  );
  for (let n = 1; n <= 6; n++) {
    await owner.query(`insert into contacts (id, organization_id, wa_id, channel, display_name) values ($1, $2, $3, 'whatsapp', $4)`, [
      person(n),
      ORG,
      `97159700010${n}`,
      `Customer ${n}`,
    ]);
  }
  const template = (
    await owner.query(
      `insert into message_templates (organization_id, meta_template_name, language, status, is_approved, body_param_count)
       values ($1, 'bulk_proof_new_homes', 'en', 'APPROVED', true, 0) returning id`,
      [ORG]
    )
  ).rows[0].id;
  // Made two hours ago and sent an hour ago, as a campaign that waited for approval is.
  campaign = (
    await owner.query(
      `insert into broadcasts (organization_id, template_id, status, from_phone_number_id, audience_filter, created_at)
       values ($1, $2, 'completed', $3, '{"scope":"admin-bulk"}', now() - interval '2 hours') returning id`,
      [ORG, template, NUMBER]
    )
  ).rows[0].id;

  await recipient(1, "sent"); // replied on the campaign's number, after the send
  await wrote(1, null, "50 minutes"); // unpinned = the business's own number
  await recipient(2, "sent"); // silent
  await recipient(3, "delivered"); // Meta sent a receipt
  await recipient(4, "failed"); // refused by Meta, though they wrote in about something else
  await wrote(4, null, "30 minutes");
  await recipient(5, "sent"); // wrote BEFORE the campaign, not since
  await wrote(5, null, "2 hours");
  await recipient(6, "sent"); // wrote since, but to a colleague's number
  await wrote(6, OTHER_NUMBER, "20 minutes");

  // A second campaign nobody has been sent yet, and an email one: neither has a WhatsApp send to time.
  const waiting = (
    await owner.query(
      `insert into broadcasts (organization_id, template_id, status, from_phone_number_id, audience_filter)
       values ($1, $2, 'scheduled', $3, '{"scope":"admin-bulk"}') returning id`,
      [ORG, template, NUMBER]
    )
  ).rows[0].id;
  await owner.query(`insert into broadcast_recipients (broadcast_id, contact_id, status) values ($1, $2, 'pending')`, [waiting, person(2)]);

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

test("a customer who answered on the campaign's number counts as delivered", db, async () => {
  const list = await lib.withTenant(ORG, () => lib.listBroadcasts(ORG));
  const sent = list.find((row) => row.id === campaign);
  assert.equal(sent.recipients, 6);
  assert.equal(sent.failed, 1, "a refused message stays refused, whatever the customer wrote");
  assert.equal(sent.sent, 5, "accepted by WhatsApp: everyone but the refused one");
  // Customer 3 by Meta's receipt, customer 1 by their own reply. Not 2 (silent),
  // 4 (refused), 5 (wrote before the send) or 6 (wrote to another number).
  assert.equal(sent.delivered, 2);
});

test("what Meta's receipts said is left as it was", db, async () => {
  const { rows } = await owner.query(
    `select status, count(*)::int as n from broadcast_recipients where broadcast_id = $1 group by status order by status`,
    [campaign]
  );
  assert.deepEqual(rows, [
    { status: "delivered", n: 1 },
    { status: "failed", n: 1 },
    { status: "sent", n: 4 },
  ]);
});

test("a campaign's send times name its number and when it went, newest first, only once something was sent", db, async () => {
  const times = await lib.withTenant(ORG, () => lib.campaignSendTimes(ORG));
  assert.equal(times.length, 1, "the waiting campaign has sent nothing yet");
  assert.equal(times[0].id, campaign);
  assert.equal(times[0].fromPhoneNumberId, NUMBER);
  const ago = Date.now() - new Date(times[0].firstSentAt).getTime();
  assert.ok(ago > 55 * 60_000 && ago < 65 * 60_000, "sent about an hour ago");
});
