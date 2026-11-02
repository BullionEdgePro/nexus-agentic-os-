// The SFS workflow audit counts what happened (2 Nov 2026).
//
// Every number on the audit page comes from this one read. The source checks
// always run. The database cases run only against a throwaway Postgres —
// schema.sql plus every migration — seeded as the owner and read as the
// app's own role (`nexus_app`), so the row-level security production runs
// under is the one these numbers pass through:
//
//   AUDIT_TEST_OWNER_URL=postgres://nexus:x@localhost:55433/nexus
//   AUDIT_TEST_APP_URL=postgres://nexus_app:x@localhost:55433/nexus
//
// Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §7
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const SRC = readFileSync(join(root, "packages", "db", "src", "workflow-audit.ts"), "utf8");

test("the audit reads inside the business's tenant scope, in its own days", () => {
  assert.match(SRC, /withTenant\(input\.organizationId,/);
  assert.match(SRC, /at time zone \$/);
  assert.match(SRC, /coalesce\(c\.routed_organization_id, c\.organization_id\)/);
  assert.match(SRC, /sender_type = 'contact'/);
  assert.match(SRC, /category = 'inbound_pitch'/);
  assert.match(SRC, /lower\(trim\(/);
  // The pipeline's per-message timer is capped at 24 hours and never sees a
  // person's reply; first replies come from the messages themselves.
  assert.doesNotMatch(SRC, /first_response_ms/);
  // Row-level security keeps other businesses out, and every query also says
  // whose rows it wants (spec §7.3) — a shared-number customer has rows in more
  // than one business, so a read keyed only on the contact would mix them.
  for (const m of SRC.matchAll(/from (lead_assessments|bookings|lead_labels) (\w+)/g)) {
    assert.match(SRC.slice(m.index, m.index + 420), new RegExp(`${m[2]}\\.(serving_)?organization_id = \\$1`), `"${m[0]}" is not filtered by the business`);
  }
  // A score belongs to the business serving its chat (migration 105), not the number's owner.
  assert.doesNotMatch(SRC, /la\.organization_id = \$1/);
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const SFS = "51515151-0000-4000-8000-000000000001";
const OTHER = "51515151-0000-4000-8000-000000000002";
// A third business, only for the Dubai day edges, so SFS's counts stay as they are.
const EDGE = "51515151-0000-4000-8000-000000000003";

let owner;
let dbTurn; // this file's turn at the shared test database
let getWorkflowAudit;

/** Dubai midnight `daysAgo` days back, plus `plus` (an interval), as a timestamptz expression. */
const dubai = (daysAgo, plus = "0 minutes") =>
  `((date_trunc('day', now() at time zone 'Asia/Dubai') - interval '${daysAgo} days' + interval '${plus}') at time zone 'Asia/Dubai')`;

const SEED = `
insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
values ('${SFS}', 'sfs-international', 'SFS International', '900001', '800001', 'Asia/Dubai'),
       ('${OTHER}', 'other-firm', 'Other Firm', '900002', '800002', 'Asia/Dubai'),
       ('${EDGE}', 'edge-firm', 'Edge Firm', '900003', '800003', 'Asia/Dubai');

-- SFS's people
insert into contacts (id, organization_id, wa_id, channel, display_name, lead_source) values
  ('c0000000-0000-4000-8000-000000000001', '${SFS}', '971500000001', 'whatsapp', 'Lead one', 'Bayut'),
  ('c0000000-0000-4000-8000-000000000002', '${SFS}', '971500000002', 'whatsapp', 'Lead two', ' bayut '),
  ('c0000000-0000-4000-8000-000000000004', '${SFS}', '971500000004', 'whatsapp', 'A pitch', null),
  ('c0000000-0000-4000-8000-000000000005', '${SFS}', '971500000005', 'whatsapp', 'Never answered us', null);
insert into contacts (id, organization_id, channel, external_id, display_name) values
  ('c0000000-0000-4000-8000-000000000003', '${OTHER}', 'instagram', 'ig-3', 'Routed lead');
insert into contacts (id, organization_id, wa_id, channel, display_name, not_a_customer_at) values
  ('c0000000-0000-4000-8000-000000000006', '${SFS}', '971500000006', 'whatsapp', 'Not a customer', now());
-- The other firm's own leads
insert into contacts (id, organization_id, wa_id, channel, display_name) values
  ('c0000000-0000-4000-8000-000000000007', '${OTHER}', '971500000007', 'whatsapp', 'Other one'),
  ('c0000000-0000-4000-8000-000000000008', '${OTHER}', '971500000008', 'whatsapp', 'Other two');
-- Unsubscribed from campaign emails: one of SFS's, one of the other firm's.
update contacts set email_campaigns_opted_out_at = now()
 where id in ('c0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000007');

insert into conversations (id, organization_id, routed_organization_id, contact_id, opened_at) values
  ('d0000000-0000-4000-8000-000000000001', '${SFS}', null, 'c0000000-0000-4000-8000-000000000001', ${dubai(2, "10 hours")}),
  ('d0000000-0000-4000-8000-000000000002', '${SFS}', null, 'c0000000-0000-4000-8000-000000000002', ${dubai(1, "23 hours 30 minutes")}),
  ('d0000000-0000-4000-8000-000000000003', '${OTHER}', '${SFS}', 'c0000000-0000-4000-8000-000000000003', ${dubai(3, "9 hours")}),
  ('d0000000-0000-4000-8000-000000000004', '${SFS}', null, 'c0000000-0000-4000-8000-000000000004', ${dubai(1, "9 hours")}),
  ('d0000000-0000-4000-8000-000000000005', '${SFS}', null, 'c0000000-0000-4000-8000-000000000005', ${dubai(1, "11 hours")}),
  ('d0000000-0000-4000-8000-000000000006', '${SFS}', null, 'c0000000-0000-4000-8000-000000000006', ${dubai(2, "12 hours")}),
  ('d0000000-0000-4000-8000-000000000007', '${OTHER}', null, 'c0000000-0000-4000-8000-000000000007', ${dubai(2, "9 hours")}),
  ('d0000000-0000-4000-8000-000000000008', '${OTHER}', null, 'c0000000-0000-4000-8000-000000000008', ${dubai(2, "10 hours")});

insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, created_at) values
  ('${SFS}', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'inbound', 'contact', 'Is the villa free?', ${dubai(2, "10 hours")}),
  ('${SFS}', 'd0000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'outbound', 'ai_agent', 'Yes — when can you view?', ${dubai(2, "10 hours 5 minutes")}),
  ('${SFS}', 'd0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'inbound', 'contact', 'Price?', ${dubai(1, "23 hours 30 minutes")}),
  ('${SFS}', 'd0000000-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-000000000002', 'outbound', 'human_agent', '4.5M', ${dubai(1, "23 hours 40 minutes")}),
  ('${OTHER}', 'd0000000-0000-4000-8000-000000000003', 'c0000000-0000-4000-8000-000000000003', 'inbound', 'contact', 'Hello', ${dubai(3, "9 hours")}),
  ('${SFS}', 'd0000000-0000-4000-8000-000000000004', 'c0000000-0000-4000-8000-000000000004', 'inbound', 'contact', 'We sell SEO', ${dubai(1, "9 hours")}),
  ('${SFS}', 'd0000000-0000-4000-8000-000000000005', 'c0000000-0000-4000-8000-000000000005', 'outbound', 'human_agent', 'New listings for you', ${dubai(1, "11 hours")}),
  ('${SFS}', 'd0000000-0000-4000-8000-000000000006', 'c0000000-0000-4000-8000-000000000006', 'inbound', 'contact', 'Hi', ${dubai(2, "12 hours")}),
  ('${OTHER}', 'd0000000-0000-4000-8000-000000000007', 'c0000000-0000-4000-8000-000000000007', 'inbound', 'contact', 'Hi', ${dubai(2, "9 hours")}),
  ('${OTHER}', 'd0000000-0000-4000-8000-000000000008', 'c0000000-0000-4000-8000-000000000008', 'inbound', 'contact', 'Hi', ${dubai(2, "10 hours")});

insert into lead_assessments (id, organization_id, contact_id, conversation_id, score, priority, category, created_at) values
  ('a0000000-0000-4000-8000-000000000001', '${SFS}', 'c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 80, 'high', 'purchase_intent', ${dubai(2, "10 hours 1 minute")}),
  ('a0000000-0000-4000-8000-000000000002', '${SFS}', 'c0000000-0000-4000-8000-000000000002', 'd0000000-0000-4000-8000-000000000002', 40, 'normal', 'purchase_intent', ${dubai(1, "23 hours 31 minutes")}),
  ('a0000000-0000-4000-8000-000000000004', '${SFS}', 'c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000004', 5, 'low', 'inbound_pitch', ${dubai(1, "9 hours 1 minute")}),
  -- Every inbound message is scored: lead one's second message is a second row,
  -- still one lead scored and one hot lead.
  ('a0000000-0000-4000-8000-000000000005', '${SFS}', 'c0000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 85, 'urgent', 'purchase_intent', ${dubai(2, "10 hours 6 minutes")}),
  -- The routed chat is scored under the number's owner, and counts for SFS,
  -- the business serving it (migration 105).
  ('a0000000-0000-4000-8000-000000000003', '${OTHER}', 'c0000000-0000-4000-8000-000000000003', 'd0000000-0000-4000-8000-000000000003', 90, 'high', 'purchase_intent', ${dubai(3, "9 hours 1 minute")});

-- A sales pitch routed to SFS through the shared number: filed under the
-- number's owner like every score, and filtered out of SFS's new leads.
insert into contacts (id, organization_id, channel, external_id, display_name) values
  ('c0000000-0000-4000-8000-000000000009', '${OTHER}', 'facebook', 'fb-9', 'We sell leads');
insert into conversations (id, organization_id, routed_organization_id, contact_id, opened_at) values
  ('d0000000-0000-4000-8000-000000000009', '${OTHER}', '${SFS}', 'c0000000-0000-4000-8000-000000000009', ${dubai(2, "14 hours")});
insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, created_at) values
  ('${OTHER}', 'd0000000-0000-4000-8000-000000000009', 'c0000000-0000-4000-8000-000000000009', 'inbound', 'contact', 'Buy our lead lists', ${dubai(2, "14 hours")});
insert into lead_assessments (id, organization_id, contact_id, conversation_id, score, priority, category, created_at) values
  ('a0000000-0000-4000-8000-000000000009', '${OTHER}', 'c0000000-0000-4000-8000-000000000009', 'd0000000-0000-4000-8000-000000000009', 3, 'low', 'inbound_pitch', ${dubai(2, "14 hours 1 minute")});

insert into lead_labels (organization_id, assessment_id, worth_attention, outcome, labelled_by, created_at, updated_at) values
  ('${SFS}', 'a0000000-0000-4000-8000-000000000001', true, 'won', 'owner', ${dubai(1, "8 hours")}, ${dubai(1, "8 hours")});

insert into bookings (organization_id, contact_id, starts_at, ends_at, status) values
  ('${SFS}', 'c0000000-0000-4000-8000-000000000001', ${dubai(1, "15 hours")}, ${dubai(1, "16 hours")}, 'completed'),
  ('${SFS}', 'c0000000-0000-4000-8000-000000000005', ${dubai(1, "17 hours")}, ${dubai(1, "18 hours")}, 'no_show'),
  ('${SFS}', 'c0000000-0000-4000-8000-000000000001', ${dubai(2, "15 hours")}, ${dubai(2, "16 hours")}, 'cancelled');
-- Lead two (scored normal, not hot) has a viewing booked for the day after
-- tomorrow: not yet a viewing of the period, and not past "hot" in the funnel.
insert into bookings (organization_id, contact_id, starts_at, ends_at, status) values
  ('${SFS}', 'c0000000-0000-4000-8000-000000000002', now() + interval '2 days', now() + interval '2 days 1 hour', 'confirmed');

-- The Dubai day edges, at the edge firm. 01:30 Dubai yesterday is 21:30 UTC the
-- day before; 00:30 Dubai on the 7-day period's first day is 20:30 UTC the day
-- before it; 23:30 Dubai the night before that is outside the period either way.
insert into contacts (id, organization_id, wa_id, channel, display_name) values
  ('c0000000-0000-4000-8000-000000000011', '${EDGE}', '971500000011', 'whatsapp', 'Small hours'),
  ('c0000000-0000-4000-8000-000000000012', '${EDGE}', '971500000012', 'whatsapp', 'First minute'),
  ('c0000000-0000-4000-8000-000000000013', '${EDGE}', '971500000013', 'whatsapp', 'Night before');
insert into conversations (id, organization_id, routed_organization_id, contact_id, opened_at) values
  ('d0000000-0000-4000-8000-000000000011', '${EDGE}', null, 'c0000000-0000-4000-8000-000000000011', ${dubai(1, "1 hour 30 minutes")}),
  ('d0000000-0000-4000-8000-000000000012', '${EDGE}', null, 'c0000000-0000-4000-8000-000000000012', ${dubai(6, "30 minutes")}),
  ('d0000000-0000-4000-8000-000000000013', '${EDGE}', null, 'c0000000-0000-4000-8000-000000000013', ${dubai(6, "-30 minutes")});
insert into messages (organization_id, conversation_id, contact_id, direction, sender_type, body, created_at) values
  ('${EDGE}', 'd0000000-0000-4000-8000-000000000011', 'c0000000-0000-4000-8000-000000000011', 'inbound', 'contact', 'Up late', ${dubai(1, "1 hour 30 minutes")}),
  ('${EDGE}', 'd0000000-0000-4000-8000-000000000012', 'c0000000-0000-4000-8000-000000000012', 'inbound', 'contact', 'Just after midnight', ${dubai(6, "30 minutes")}),
  ('${EDGE}', 'd0000000-0000-4000-8000-000000000013', 'c0000000-0000-4000-8000-000000000013', 'inbound', 'contact', 'Just before', ${dubai(6, "-30 minutes")});
`;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  // One database test file at a time: they share the throwaway database, and a
  // migration one re-applies deadlocks with another's seed (2 Nov 2026).
  dbTurn = await owner.connect();
  await dbTurn.query("select pg_advisory_lock(20261102)");
  await owner.query(SEED);
  process.env.DATABASE_URL = APP_URL;
  ({ getWorkflowAudit } = await import("@nexus/db"));
});

after(async () => {
  if (db.skip) return;
  // Messages and scores first: their serving-business keys do not cascade.
  await owner.query(
    `delete from messages where organization_id in ('${SFS}', '${OTHER}', '${EDGE}') or serving_organization_id in ('${SFS}', '${OTHER}', '${EDGE}')`
  );
  await owner.query(
    `delete from lead_assessments where organization_id in ('${SFS}', '${OTHER}', '${EDGE}') or serving_organization_id in ('${SFS}', '${OTHER}', '${EDGE}')`
  );
  await owner.query(`delete from organizations where id in ('${SFS}', '${OTHER}', '${EDGE}')`);
  if (dbTurn) {
    await dbTurn.query("select pg_advisory_unlock(20261102)");
    dbTurn.release();
  }
  await owner.end();
  const { getPool } = await import("@nexus/db");
  await getPool().end();
});

const sfs = (days = 7) =>
  getWorkflowAudit({ organizationId: SFS, slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai", days });

test("counts SFS's real activity and nothing of the other business", db, async () => {
  const a = await sfs();
  assert.equal(a.evidence.leads.total, 3);
  assert.equal(a.evidence.leads.pitches, 2);
  assert.equal(a.evidence.leads.byChannel.whatsapp, 2);
  assert.deepEqual(a.evidence.leads.bySource[0], { source: "Bayut", count: 2 });
  assert.deepEqual([a.evidence.replies.byAi, a.evidence.replies.byPerson, a.evidence.replies.unanswered], [1, 1, 1]);
  assert.equal(a.evidence.replies.medianMs, 450_000);
  assert.deepEqual(a.evidence.viewings, { booked: 2, held: 1, noShow: 1, cancelled: 1 });
  assert.equal(a.evidence.qualifier.scored, 3);
  assert.equal(a.evidence.qualifier.hot, 2);
  assert.equal(a.evidence.won, 1);
  assert.equal(a.evidence.contacts.notACustomer, 1);
  assert.equal(a.evidence.contacts.emailOptedOut, 1);
  assert.deepEqual(a.funnel, { leads: 3, scored: 3, hot: 2, booked: 1, held: 1, won: 1 });
  assert.equal(a.series.leads.length, 7);
  assert.ok(a.series.replyMedian.some((r) => r.medianMs === null), "a day with no replies is null, never 0");
  assert.equal(a.period.bucket, "day");
});

test("a chat routed to SFS through a shared number is SFS's lead, not the number owner's", db, async () => {
  const a = await sfs();
  assert.equal(a.evidence.leads.byChannel.instagram, 1);
  // SFS's customers are the ones it serves: five on its own number plus the
  // two routed ones, whose rows belong to the number's owner.
  assert.equal(a.evidence.contacts.total, 7);
  const other = await getWorkflowAudit({ organizationId: OTHER, slug: "other-firm", name: "Other Firm", timezone: "Asia/Dubai", days: 7 });
  assert.equal(other.evidence.leads.total, 2);
});

test("a conversation SFS opened that nobody answered is not a lead", db, async () => {
  const a = await sfs();
  // Its contact had a no-show viewing, but it is no lead, so no unanswered
  // reply and no place in the funnel.
  assert.equal(a.evidence.replies.unanswered, 1);
  assert.equal(a.funnel.booked, 1);
});

test("a lead at 23:30 Dubai time on a day is that day, not the next", db, async () => {
  const a = await sfs();
  const { rows } = await owner.query(
    `select to_char((now() at time zone 'Asia/Dubai')::date - 1, 'YYYY-MM-DD') as yesterday,
            to_char((now() at time zone 'Asia/Dubai')::date, 'YYYY-MM-DD') as today`
  );
  const count = (day) => a.series.leads.find((b) => b.bucket === day)?.count;
  assert.equal(count(rows[0].yesterday), 1);
  assert.equal(count(rows[0].today), 0);
  assert.equal(a.period.today, rows[0].today);
});

test("90 days reads in Monday weeks", db, async () => {
  const a = await sfs(90);
  assert.equal(a.period.bucket, "week");
  for (const b of a.series.leads) assert.equal(new Date(`${b.bucket}T00:00:00Z`).getUTCDay(), 1, b.bucket);
  assert.equal(a.evidence.leads.total, 3);
  // The SQL's own week keys meet the page's: every lead lands in a drawn week.
  assert.equal(a.series.leads.reduce((sum, b) => sum + b.count, 0), a.evidence.leads.total);
});

test("the period and its days begin at Dubai midnight, not UTC midnight", db, async () => {
  const a = await getWorkflowAudit({ organizationId: EDGE, slug: "edge-firm", name: "Edge Firm", timezone: "Asia/Dubai", days: 7 });
  const { rows } = await owner.query(
    `select to_char((now() at time zone 'Asia/Dubai')::date - 1, 'YYYY-MM-DD') as yesterday,
            to_char((now() at time zone 'Asia/Dubai')::date - 6, 'YYYY-MM-DD') as first`
  );
  const count = (day) => a.series.leads.find((b) => b.bucket === day)?.count;
  assert.equal(a.period.from, rows[0].first);
  // 00:30 Dubai on the first day is in; 23:30 the night before is out.
  assert.equal(a.evidence.leads.total, 2);
  assert.equal(count(rows[0].first), 1);
  // 01:30 Dubai yesterday is yesterday, though in UTC it is the day before.
  assert.equal(count(rows[0].yesterday), 1);
});

test("scored and hot count people, not the messages that were scored", db, async () => {
  const a = await sfs();
  // Lead one's two scored messages (high, then urgent) are one lead scored and
  // one hot lead; with lead two and the routed lead, three scored and two hot.
  assert.equal(a.evidence.qualifier.scored, 3);
  assert.equal(a.evidence.qualifier.hot, 2);
  assert.equal(a.series.quality.reduce((sum, b) => sum + b.scored, 0), 3);
  assert.equal(a.series.quality.reduce((sum, b) => sum + b.hot, 0), 2);
});

test("a routed chat's scoring counts for the business serving it", db, async () => {
  // The pipeline scores a routed chat under the shared number's owner; since
  // migration 105 the score belongs to the business serving the chat. So SFS's
  // routed lead is scored and hot, its routed pitch is filtered out, and the
  // number's owner counts neither.
  const a = await sfs();
  assert.equal(a.evidence.leads.byChannel.instagram, 1);
  assert.equal(a.evidence.leads.byChannel.facebook, undefined, "the routed pitch is no new lead");
  assert.equal(a.evidence.qualifier.scored, 3);
  assert.equal(a.funnel.scored, 3);
  const other = await getWorkflowAudit({ organizationId: OTHER, slug: "other-firm", name: "Other Firm", timezone: "Asia/Dubai", days: 7 });
  assert.equal(other.evidence.qualifier.scored, 0);
  assert.equal(other.evidence.leads.pitches, 0);
});

test("the funnel narrows: each step counts only people who reached every step before it", db, async () => {
  const { funnel } = await sfs();
  // Lead two booked a viewing without being hot; the funnel's "booked" is of the hot.
  assert.equal(funnel.booked, 1);
  const steps = [funnel.leads, funnel.scored, funnel.hot, funnel.booked, funnel.held, funnel.won];
  steps.slice(1).forEach((n, i) => assert.ok(n <= steps[i], `step ${i + 1} (${n}) is more than the step before (${steps[i]})`));
});
