// A business serving routed chats reads their rows, and never rewrites them
// (2 Nov 2026, migration 106).
//
// Migrations 054, 056 and 058 widened the USING clause of one policy per table
// so the business a chat is routed to can read it. A policy for every command
// widens what UPDATE and DELETE reach too: under its own tenant the serving
// business could delete the number owner's conversations, messages, metrics and
// shared contacts (a contact's delete cascades into every business's rows), or
// rewrite organization_id to take them over. Migration 106 adds owner-only
// RESTRICTIVE policies for UPDATE and DELETE; reads and 058's reply insert stay.
//
// Seeds as the owner role and acts as nexus_app, so row-level security does the
// work. Its own ids, so it can run beside the other database tests.
// Spec: docs/superpowers/specs/2026-11-02-serving-read-only-design.md
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const MIGRATION = join(root, "packages", "db", "migrations", "106-a-serving-business-reads-but-never-rewrites.sql");
const SQL = readFileSync(MIGRATION, "utf8");

test("the migration adds owner-only updates and deletes, in one bounded transaction, and checks itself", () => {
  const code = SQL.replace(/^\s*--[^\n]*$/gm, "").trim();
  assert.match(code, /^begin;\s*set local lock_timeout = '5s';/);
  assert.match(code, /commit;$/);
  assert.equal((code.match(/as restrictive/g) ?? []).length, 8);
  for (const table of ["conversations", "conversation_metrics", "messages", "contacts"]) {
    assert.match(code, new RegExp(`create policy ${table}_owner_updates on ${table}\\s+as restrictive\\s+for update`));
    assert.match(code, new RegExp(`create policy ${table}_owner_deletes on ${table}\\s+as restrictive\\s+for delete`));
  }
  // The existing policies are left exactly as 054, 056 and 058 wrote them.
  assert.doesNotMatch(code, /drop policy if exists \w+_tenant_isolation/);
  assert.match(code, /raise exception/);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const OWNER = "71717171-0000-4000-8000-000000000001"; // owns the shared number
const SERVING = "71717171-0000-4000-8000-000000000002"; // a business it routes to
const THIRD = "71717171-0000-4000-8000-000000000003";
const ORGS = [OWNER, SERVING, THIRD];

let owner;
let dbTurn; // this file's turn at the shared test database
let withTenant;
let withAllTenants;
let getPool;

const id = (kind, n) => `${kind}7171710-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A chat on the owner's number, routed to SERVING: its contact, conversation, message and metric. */
async function routedChat(n) {
  const chat = { contact: id("c", n), conversation: id("d", n), message: id("e", n), metric: id("f", n) };
  await owner.query(
    `insert into contacts (id, organization_id, wa_id, channel, display_name) values ($1, $2, $3, 'whatsapp', 'Shared customer')`,
    [chat.contact, OWNER, `97159200${String(n).padStart(4, "0")}`]
  );
  await owner.query(
    `insert into conversations (id, organization_id, routed_organization_id, contact_id, opened_at) values ($1, $2, $3, $4, now())`,
    [chat.conversation, OWNER, SERVING, chat.contact]
  );
  await owner.query(
    `insert into messages (id, organization_id, conversation_id, contact_id, direction, sender_type, body)
     values ($1, $2, $3, $4, 'inbound', 'contact', 'Is the flat free?')`,
    [chat.message, OWNER, chat.conversation, chat.contact]
  );
  await owner.query(`insert into conversation_metrics (id, organization_id, conversation_id) values ($1, $2, $3)`, [
    chat.metric,
    OWNER,
    chat.conversation,
  ]);
  return chat;
}

/**
 * One statement under a business's own tenant: rows affected, or "refused" when
 * row-level security raises or the app role holds no grant for it (messages
 * have had no DELETE grant since migration 048: nothing deletes a message).
 */
async function asTenant(org, sql, params) {
  try {
    return await withTenant(org, async () => (await getPool().query(sql, params)).rowCount);
  } catch (err) {
    if (/row-level security|permission denied/.test(String(err?.message))) return "refused";
    throw err;
  }
}
const ownerSees = async (table, rowId) =>
  (await owner.query(`select organization_id from ${table} where id = $1`, [rowId])).rows[0]?.organization_id ?? null;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  // One database test file at a time: they share the throwaway database, and a
  // migration one re-applies deadlocks with another's seed (2 Nov 2026).
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(SQL); // the database may predate 106; the file is safe to re-run
  await owner.query(
    `insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
     values ($1, 'sro-owner', 'Number Owner', '920001', '820001', 'Asia/Dubai'),
            ($2, 'sro-serving', 'Serving Firm', '920002', '820002', 'Asia/Dubai'),
            ($3, 'sro-third', 'Third Firm', '920003', '820003', 'Asia/Dubai')`,
    ORGS
  );
  process.env.DATABASE_URL = APP_URL;
  ({ withTenant, withAllTenants, getPool } = await import("@nexus/db"));
});

after(async () => {
  if (db.skip) return;
  const list = ORGS.map((o) => `'${o}'`).join(", ");
  // Messages and scores first: their serving-business keys do not cascade.
  await owner.query(`delete from messages where organization_id in (${list}) or serving_organization_id in (${list})`);
  await owner.query(`delete from lead_assessments where organization_id in (${list}) or serving_organization_id in (${list})`);
  await owner.query(`delete from conversations where organization_id in (${list}) or routed_organization_id in (${list})`);
  await owner.query(`delete from organizations where id in (${list})`);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  if (getPool) await getPool().end(); // before() may have failed before it loaded
});

test("a serving business reads every routed row and still answers in the chat", db, async () => {
  const chat = await routedChat(1);
  assert.equal(await asTenant(SERVING, `select 1 from conversations where id = $1`, [chat.conversation]), 1);
  assert.equal(await asTenant(SERVING, `select 1 from messages where id = $1`, [chat.message]), 1);
  assert.equal(await asTenant(SERVING, `select 1 from conversation_metrics where id = $1`, [chat.metric]), 1);
  assert.equal(await asTenant(SERVING, `select 1 from contacts where id = $1`, [chat.contact]), 1);
  // 058: a firm may answer its own customer.
  const replied = await asTenant(
    SERVING,
    `insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body)
     values ($1, $2, $3, 'outbound', 'human_agent', 'Yes, it is free')`,
    [OWNER, chat.conversation, chat.contact]
  );
  assert.equal(replied, 1);
  // A business the chat is not routed to sees none of it.
  assert.equal(await asTenant(THIRD, `select 1 from conversations where id = $1`, [chat.conversation]), 0);
});

test("a serving business deletes nothing it does not own", db, async () => {
  const chat = await routedChat(2);
  // Messages are append-only by grant (048); 106's policy is a second lock on that door.
  assert.equal(await asTenant(SERVING, `delete from messages where id = $1`, [chat.message]), "refused");
  assert.equal(await asTenant(SERVING, `delete from conversation_metrics where id = $1`, [chat.metric]), 0);
  assert.equal(await asTenant(SERVING, `delete from conversations where id = $1`, [chat.conversation]), 0);
  // The contact last: its delete would cascade into every business's rows for this person.
  assert.equal(await asTenant(SERVING, `delete from contacts where id = $1`, [chat.contact]), 0);
  for (const [table, rowId] of [["messages", chat.message], ["conversation_metrics", chat.metric], ["conversations", chat.conversation], ["contacts", chat.contact]]) {
    assert.equal(await ownerSees(table, rowId), OWNER, `${table} row still there`);
  }
});

test("a serving business cannot take a row over", db, async () => {
  const chat = await routedChat(3);
  for (const [table, rowId] of [["messages", chat.message], ["conversation_metrics", chat.metric], ["conversations", chat.conversation], ["contacts", chat.contact]]) {
    const moved = await asTenant(SERVING, `update ${table} set organization_id = $2 where id = $1`, [rowId, SERVING]);
    assert.notEqual(moved, 1, `${table} was taken over`);
    assert.equal(await ownerSees(table, rowId), OWNER, `${table} still the owner's`);
  }
});

test("a serving business's ordinary edits change nothing", db, async () => {
  const chat = await routedChat(4);
  const edits = [
    ["conversations", `update conversations set status = 'closed' where id = $1`, chat.conversation, `select status as v from conversations where id = $1`],
    ["messages", `update messages set status = 'read' where id = $1`, chat.message, `select status as v from messages where id = $1`],
    ["conversation_metrics", `update conversation_metrics set input_tokens = 99 where id = $1`, chat.metric, `select input_tokens as v from conversation_metrics where id = $1`],
    ["contacts", `update contacts set display_name = 'Renamed' where id = $1`, chat.contact, `select display_name as v from contacts where id = $1`],
  ];
  for (const [table, edit, rowId, read] of edits) {
    const before = (await owner.query(read, [rowId])).rows[0].v;
    const result = await asTenant(SERVING, edit, [rowId]);
    assert.notEqual(result, 1, `${table} was edited by the serving business`);
    assert.deepEqual((await owner.query(read, [rowId])).rows[0].v, before, `${table} unchanged`);
  }
});

test("the owner and cross-tenant work still update and delete", db, async () => {
  const chat = await routedChat(5);
  assert.equal(await asTenant(OWNER, `update conversations set status = 'pending' where id = $1`, [chat.conversation]), 1);
  assert.equal(await asTenant(OWNER, `update contacts set display_name = 'Owner named' where id = $1`, [chat.contact]), 1);
  assert.equal(await asTenant(OWNER, `update messages set status = 'read' where id = $1`, [chat.message]), 1);
  assert.equal(await asTenant(OWNER, `delete from conversation_metrics where id = $1`, [chat.metric]), 1);
  // Cross-tenant work (the inbox's /api/conversations/... routes, webhooks) is unaffected.
  const across = await withAllTenants("test: the inbox acts across businesses", async () => [
    (await getPool().query(`update messages set status = 'delivered' where id = $1`, [chat.message])).rowCount,
    (await getPool().query(`delete from conversations where id = $1`, [chat.conversation])).rowCount,
  ]);
  assert.deepEqual(across, [1, 1]);
});

test("106 runs twice", db, async () => {
  await owner.query(SQL);
  await owner.query(SQL);
});
