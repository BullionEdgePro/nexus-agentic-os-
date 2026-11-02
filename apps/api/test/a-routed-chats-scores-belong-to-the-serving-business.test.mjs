// A routed chat's lead scores belong to the business serving it (2 Nov 2026,
// migration 105).
//
// All five businesses share Zipicka's number, and scoring runs inside the
// number owner's transaction, so every score was filed under the owner — where
// the business actually answering the chat could not see it. Migration 105
// gives lead_assessments the serving column messages got in 054: kept true by
// trigger (on insert, and when the triage menu routes a chat after its first
// scored message), backfilled, and read by the widened policy. Writes stay with
// the owner.
//
// Seeds as the owner role and reads as nexus_app, so row-level security does
// real work. Its own ids, so it can run beside the workflow audit's test.
// Spec: docs/superpowers/specs/2026-11-02-routed-scoring-design.md
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const MIGRATION = join(root, "packages", "db", "migrations", "105-a-routed-chats-scores-belong-to-the-serving-business.sql");
const SQL = readFileSync(MIGRATION, "utf8");

test("the migration keeps writes owner-only and checks itself", () => {
  assert.match(
    SQL,
    /with check \(\s*organization_id::text = current_setting\('app\.current_org', true\)\s*or current_setting\('app\.tenant_scope', true\) = 'all'\s*\)/
  );
  assert.match(SQL, /serving_organization_id::text = current_setting\('app\.current_org', true\)/);
  assert.match(SQL, /raise exception/);
  assert.match(SQL, /alter column serving_organization_id set not null/);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const OWNER = "61616161-0000-4000-8000-000000000001"; // owns the shared number
const SERVING = "61616161-0000-4000-8000-000000000002"; // a business it routes to
const THIRD = "61616161-0000-4000-8000-000000000003"; // another business on the number
const ORGS = [OWNER, SERVING, THIRD];

const ROUTED_CT = "c6161610-0000-4000-8000-000000000001";
const CAPTURED_CT = "c6161610-0000-4000-8000-000000000002";
const ROUTED_CONV = "d6161610-0000-4000-8000-000000000001"; // routed to SERVING
const PLAIN_CONV = "d6161610-0000-4000-8000-000000000002"; // the owner's own chat, same person
const MOVING_CONV = "d6161610-0000-4000-8000-000000000003"; // routed after it was scored
const DOOMED_CONV = "d6161610-0000-4000-8000-000000000004"; // routed, then deleted

let owner;
let withTenant;
let recordLeadAssessment;
let getContact;
let recordLeadLabel;

const SEED = `
insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
values ('${OWNER}', 'rs-owner', 'Number Owner', '910001', '810001', 'Asia/Dubai'),
       ('${SERVING}', 'rs-serving', 'Serving Firm', '910002', '810002', 'Asia/Dubai'),
       ('${THIRD}', 'rs-third', 'Third Firm', '910003', '810003', 'Asia/Dubai');
insert into contacts (id, organization_id, wa_id, channel, display_name) values
  ('${ROUTED_CT}', '${OWNER}', '971591000001', 'whatsapp', 'Served by two'),
  ('${CAPTURED_CT}', '${OWNER}', '971591000002', 'whatsapp', 'Captured by staff');
insert into conversations (id, organization_id, routed_organization_id, contact_id, opened_at) values
  ('${ROUTED_CONV}', '${OWNER}', '${SERVING}', '${ROUTED_CT}', now() - interval '3 hours'),
  ('${PLAIN_CONV}', '${OWNER}', null, '${ROUTED_CT}', now() - interval '2 hours'),
  ('${MOVING_CONV}', '${OWNER}', null, '${ROUTED_CT}', now() - interval '1 hour'),
  ('${DOOMED_CONV}', '${OWNER}', '${SERVING}', '${ROUTED_CT}', now() - interval '30 minutes');
insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, created_at) values
  ('${OWNER}', '${ROUTED_CONV}', '${ROUTED_CT}', 'inbound', 'contact', 'Is the flat still free?', now() - interval '3 hours'),
  ('${OWNER}', '${PLAIN_CONV}', '${ROUTED_CT}', 'inbound', 'contact', 'Do you sell perfume?', now() - interval '2 hours'),
  ('${OWNER}', '${MOVING_CONV}', '${ROUTED_CT}', 'inbound', 'contact', 'hi', now() - interval '1 hour');
`;

const score = (conversationId, contactId = ROUTED_CT) => ({
  organizationId: OWNER,
  contactId,
  conversationId,
  messageId: null,
  score: 70,
  priority: "high",
  category: "purchase_intent",
  signals: [],
});

/** The id of the one score on a conversation (or on a contact with no conversation). */
async function scoreId(conversationId, contactId = ROUTED_CT) {
  const { rows } = await owner.query(
    `select id from lead_assessments where contact_id = $1 and conversation_id is not distinct from $2::uuid`,
    [contactId, conversationId]
  );
  assert.equal(rows.length, 1, `one score on ${conversationId ?? contactId}`);
  return rows[0].id;
}
const servingOf = async (id) =>
  (await owner.query(`select serving_organization_id from lead_assessments where id = $1`, [id])).rows[0]
    .serving_organization_id;

let routedScore;
let plainScore;
let capturedScore;
let movingScore;
let doomedScore;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  await owner.query(SQL); // the database may predate 105; the file is safe to re-run
  await owner.query(SEED);
  process.env.DATABASE_URL = APP_URL;
  ({ withTenant, getContact } = await import("@nexus/db"));
  ({ recordLeadAssessment, recordLeadLabel } = await import("@nexus/leads"));
  // Scored the way the reply pipeline scores: inside the number owner's tenant.
  for (const conv of [ROUTED_CONV, PLAIN_CONV, MOVING_CONV, DOOMED_CONV]) {
    await withTenant(OWNER, () => recordLeadAssessment(score(conv)));
  }
  await withTenant(OWNER, () => recordLeadAssessment(score(null, CAPTURED_CT)));
  routedScore = await scoreId(ROUTED_CONV);
  plainScore = await scoreId(PLAIN_CONV);
  movingScore = await scoreId(MOVING_CONV);
  doomedScore = await scoreId(DOOMED_CONV);
  capturedScore = await scoreId(null, CAPTURED_CT);
});

after(async () => {
  if (db.skip) return;
  const list = ORGS.map((o) => `'${o}'`).join(", ");
  // Messages and scores first: their serving-business keys do not cascade.
  await owner.query(`delete from messages where organization_id in (${list}) or serving_organization_id in (${list})`);
  await owner.query(`delete from lead_assessments where organization_id in (${list}) or serving_organization_id in (${list})`);
  await owner.query(`delete from organizations where id in (${list})`);
  await owner.end();
  const { getPool } = await import("@nexus/db");
  await getPool().end();
});

test("a score is filed under the business serving its chat", db, async () => {
  assert.equal(await servingOf(routedScore), SERVING);
  assert.equal(await servingOf(plainScore), OWNER);
  // A staff-captured lead has no chat and no routing: it serves its own business.
  assert.equal(await servingOf(capturedScore), OWNER);
});

test("a score written before the chat was routed follows the chat, every time it moves", db, async () => {
  const trail = [await servingOf(movingScore)];
  for (const to of [SERVING, THIRD, null]) {
    await owner.query(`update conversations set routed_organization_id = $2 where id = $1`, [MOVING_CONV, to]);
    trail.push(await servingOf(movingScore));
  }
  assert.deepEqual(trail, [OWNER, SERVING, THIRD, OWNER]);
});

test("deleting a routed chat leaves its scores with the business that served it", db, async () => {
  await owner.query(`delete from conversations where id = $1`, [DOOMED_CONV]);
  const { rows } = await owner.query(`select conversation_id, serving_organization_id from lead_assessments where id = $1`, [doomedScore]);
  assert.equal(rows[0].conversation_id, null);
  assert.equal(rows[0].serving_organization_id, SERVING);
});

test("the serving business reads its routed scores; writes still need the owner", db, async () => {
  const visible = (org) =>
    withTenant(org, async () => {
      const { getPool } = await import("@nexus/db");
      const { rows } = await getPool().query(`select id from lead_assessments where id = any($1::uuid[])`, [
        [routedScore, plainScore, capturedScore],
      ]);
      return rows.map((r) => r.id);
    });
  const served = await visible(SERVING);
  assert.ok(served.includes(routedScore), "the serving business sees the routed chat's score");
  assert.ok(!served.includes(plainScore), "but not the owner's own chat with the same person");
  assert.deepEqual(await visible(THIRD), []);
  // Writes stay with the owner: the serving business cannot file a score as the owner's…
  await assert.rejects(
    withTenant(SERVING, () => recordLeadAssessment(score(ROUTED_CONV))),
    /row-level security/
  );
  // …and the owner cannot hand a row's ownership to somebody else.
  await assert.rejects(
    withTenant(OWNER, async () => {
      const { getPool } = await import("@nexus/db");
      await getPool().query(`update lead_assessments set organization_id = $2 where id = $1`, [routedScore, SERVING]);
    }),
    /row-level security/
  );
});

test("105 repairs a wrong serving business and can run again", db, async () => {
  await owner.query(`update lead_assessments set serving_organization_id = organization_id where id = $1`, [routedScore]);
  assert.equal(await servingOf(routedScore), OWNER);
  await owner.query(SQL);
  await owner.query(SQL);
  assert.equal(await servingOf(routedScore), SERVING);
  // The backfill recomputes only what a conversation can answer: a deleted
  // chat's score keeps the business that served it, a capture keeps its own.
  assert.equal(await servingOf(doomedScore), SERVING);
  assert.equal(await servingOf(capturedScore), OWNER);
});
