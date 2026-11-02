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
});

// ---------------------------------------------------------------------------
// Against a real Postgres
// ---------------------------------------------------------------------------

const OWNER_URL = process.env.AUDIT_TEST_OWNER_URL;
const APP_URL = process.env.AUDIT_TEST_APP_URL;
const db = { skip: !(OWNER_URL && APP_URL) && "set AUDIT_TEST_OWNER_URL and AUDIT_TEST_APP_URL" };

const SFS = "51515151-0000-4000-8000-000000000001";
const OTHER = "51515151-0000-4000-8000-000000000002";

let owner;
let getWorkflowAudit;

/** Dubai midnight `daysAgo` days back, plus `plus` (an interval), as a timestamptz expression. */
const dubai = (daysAgo, plus = "0 minutes") =>
  `((date_trunc('day', now() at time zone 'Asia/Dubai') - interval '${daysAgo} days' + interval '${plus}') at time zone 'Asia/Dubai')`;

const SEED = `
insert into organizations (id, slug, name, whatsapp_phone_number_id, whatsapp_business_account_id, timezone)
values ('${SFS}', 'sfs-international', 'SFS International', '900001', '800001', 'Asia/Dubai'),
       ('${OTHER}', 'other-firm', 'Other Firm', '900002', '800002', 'Asia/Dubai');

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
  ('a0000000-0000-4000-8000-000000000004', '${SFS}', 'c0000000-0000-4000-8000-000000000004', 'd0000000-0000-4000-8000-000000000004', 5, 'low', 'inbound_pitch', ${dubai(1, "9 hours 1 minute")});

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
`;

before(async () => {
  if (db.skip) return;
  const pg = (await import("pg")).default;
  owner = new pg.Pool({ connectionString: OWNER_URL });
  await owner.query(SEED);
  process.env.DATABASE_URL = APP_URL;
  ({ getWorkflowAudit } = await import("@nexus/db"));
});

after(async () => {
  if (db.skip) return;
  // Messages first: their serving-business key does not cascade.
  await owner.query(`delete from messages where organization_id in ('${SFS}', '${OTHER}') or serving_organization_id in ('${SFS}', '${OTHER}')`);
  await owner.query(`delete from organizations where id in ('${SFS}', '${OTHER}')`);
  await owner.end();
  const { getPool } = await import("@nexus/db");
  await getPool().end();
});

const sfs = (days = 7) =>
  getWorkflowAudit({ organizationId: SFS, slug: "sfs-international", name: "SFS International", timezone: "Asia/Dubai", days });

test("counts SFS's real activity and nothing of the other business", db, async () => {
  const a = await sfs();
  assert.equal(a.evidence.leads.total, 3);
  assert.equal(a.evidence.leads.pitches, 1);
  assert.equal(a.evidence.leads.byChannel.whatsapp, 2);
  assert.deepEqual(a.evidence.leads.bySource[0], { source: "Bayut", count: 2 });
  assert.deepEqual([a.evidence.replies.byAi, a.evidence.replies.byPerson, a.evidence.replies.unanswered], [1, 1, 1]);
  assert.equal(a.evidence.replies.medianMs, 450_000);
  assert.deepEqual(a.evidence.viewings, { booked: 2, held: 1, noShow: 1, cancelled: 1 });
  assert.equal(a.evidence.qualifier.scored, 2);
  assert.equal(a.evidence.qualifier.hot, 1);
  assert.equal(a.evidence.won, 1);
  assert.equal(a.evidence.contacts.notACustomer, 1);
  assert.equal(a.evidence.contacts.emailOptedOut, 1);
  assert.deepEqual(a.funnel, { leads: 3, scored: 2, hot: 1, booked: 1, held: 1, won: 1 });
  assert.equal(a.series.leads.length, 7);
  assert.ok(a.series.replyMedian.some((r) => r.medianMs === null), "a day with no replies is null, never 0");
  assert.equal(a.period.bucket, "day");
});

test("a chat routed to SFS through a shared number is SFS's lead, not the number owner's", db, async () => {
  const a = await sfs();
  assert.equal(a.evidence.leads.byChannel.instagram, 1);
  // SFS's customers are the ones it serves: five on its own number plus the
  // routed one, whose row belongs to the number's owner.
  assert.equal(a.evidence.contacts.total, 6);
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
});

test("the funnel narrows: each step counts only people who reached every step before it", db, async () => {
  const { funnel } = await sfs();
  // Lead two booked a viewing without being hot; the funnel's "booked" is of the hot.
  assert.equal(funnel.booked, 1);
  const steps = [funnel.leads, funnel.scored, funnel.hot, funnel.booked, funnel.held, funnel.won];
  steps.slice(1).forEach((n, i) => assert.ok(n <= steps[i], `step ${i + 1} (${n}) is more than the step before (${steps[i]})`));
});
