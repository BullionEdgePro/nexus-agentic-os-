import { bucketKeys, fillBuckets, type AuditDays, type WorkflowAudit } from "@nexus/shared";
import { getPool, withTenant } from "./client.js";
import { contactServedBy } from "./contacts.js";

/**
 * The workflow audit's one read (2 Nov 2026): what happened at a business in
 * the last 7, 30 or 90 of ITS OWN days, counted from the rows themselves.
 *
 * Every query runs inside the business's tenant scope, so the database's
 * row-level security keeps every other business out as well as each query's
 * own filter. Nothing is estimated: a count with nothing behind it is 0, and a
 * reply time with no reply behind it is null — never 0, which would read as
 * an instant answer.
 *
 * A NEW LEAD is a conversation the business serves (routed to it through a
 * shared number or its own), opened in the period, with at least one message
 * from the customer — a chat the business opened that nobody answered is
 * outreach, not a lead — whose contact is not marked "not a customer", and
 * which was not scored as a sales pitch (pitches are counted apart).
 *
 * A FIRST REPLY is the first message from the AI agent or a person after the
 * customer's first message. The pipeline's own reply timer in
 * `conversation_metrics` is not used: it times the automatic pipeline per
 * inbound message and is capped at 24 hours, so a person's later reply would
 * never show.
 *
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §7
 */
export async function getWorkflowAudit(input: {
  organizationId: string;
  slug: string;
  name: string;
  timezone: string;
  days: AuditDays;
}): Promise<WorkflowAudit> {
  const bucket: "day" | "week" = input.days === 90 ? "week" : "day";
  return withTenant(input.organizationId, async () => {
    const db = getPool();
    // $1 business, $2 its timezone, $3 days, $4 bucket. The period starts at
    // local midnight `days - 1` days ago and runs to now.
    const args = [input.organizationId, input.timezone, input.days, bucket];
    const START = `(((now() at time zone $2)::date - ($3::int - 1))::timestamp at time zone $2)`;
    const BUCKET = (ts: string) => `to_char(date_trunc($4, ${ts} at time zone $2), 'YYYY-MM-DD')`;
    // The business's customers are the ones it serves — on a shared number a
    // contact's own row belongs to the number's owner (contacts.ts).
    const SERVED = contactServedBy("$1");

    const period = await db.query<{ from_day: string; today: string }>(
      `select to_char((now() at time zone $2)::date - ($3::int - 1), 'YYYY-MM-DD') as from_day,
              to_char((now() at time zone $2)::date, 'YYYY-MM-DD') as today
        where $1::uuid is not null and $4::text is not null`,
      args
    );
    const { from_day: fromDay, today } = period.rows[0]!;
    const keys = bucketKeys(fromDay, today, bucket);

    // One row per conversation opened in the period with a customer message.
    const chats = await db.query<{
      id: string;
      contact_id: string;
      bucket: string;
      channel: string;
      source_key: string | null;
      source_text: string | null;
      is_pitch: boolean;
      first_in: Date;
      reply_at: Date | null;
      reply_by: "ai_agent" | "human_agent" | null;
      scored: boolean;
      hot: boolean;
      booked: boolean;
      held: boolean;
      won: boolean;
    }>(
      `with conv as (
         select c.id, c.contact_id, c.opened_at, ct.channel,
                lower(trim(ct.lead_source)) as source_key, trim(ct.lead_source) as source_text,
                exists (select 1 from lead_assessments la
                         where la.serving_organization_id = $1 and la.conversation_id = c.id
                           and la.category = 'inbound_pitch') as is_pitch,
                (select min(m.created_at) from messages m
                  where m.conversation_id = c.id and m.sender_type = 'contact') as first_in
           from conversations c
           join contacts ct on ct.id = c.contact_id
          where coalesce(c.routed_organization_id, c.organization_id) = $1
            and c.opened_at >= ${START}
            and ct.not_a_customer_at is null
       )
       select conv.id, conv.contact_id, ${BUCKET("conv.opened_at")} as bucket, conv.channel,
              conv.source_key, conv.source_text, conv.is_pitch, conv.first_in,
              r.created_at as reply_at, r.sender_type as reply_by,
              exists (select 1 from lead_assessments la
                       where la.serving_organization_id = $1 and la.contact_id = conv.contact_id
                         and la.category <> 'inbound_pitch' and la.created_at >= conv.first_in) as scored,
              exists (select 1 from lead_assessments la
                       where la.serving_organization_id = $1 and la.contact_id = conv.contact_id
                         and la.category <> 'inbound_pitch' and la.priority in ('high', 'urgent')
                         and la.created_at >= conv.first_in) as hot,
              exists (select 1 from bookings b
                       where b.organization_id = $1 and b.contact_id = conv.contact_id
                         and b.status <> 'cancelled' and b.created_at >= conv.first_in) as booked,
              exists (select 1 from bookings b
                       where b.organization_id = $1 and b.contact_id = conv.contact_id
                         and b.status = 'completed' and b.created_at >= conv.first_in) as held,
              exists (select 1 from lead_labels ll join lead_assessments la on la.id = ll.assessment_id
                       where ll.organization_id = $1 and la.contact_id = conv.contact_id and ll.outcome = 'won'
                         and coalesce(ll.updated_at, ll.created_at) >= conv.first_in) as won
         from conv
         left join lateral (
           select m.created_at, m.sender_type from messages m
            where m.conversation_id = conv.id and m.sender_type in ('ai_agent', 'human_agent')
              and m.created_at >= conv.first_in
            order by m.created_at
            limit 1
         ) r on true
        where conv.first_in is not null`,
      args
    );
    const leads = chats.rows.filter((row) => !row.is_pitch);
    const pitches = chats.rows.length - leads.length;

    // People, not messages: every inbound message is scored, so a buyer who
    // writes twenty times has twenty rows. Scores are read by the business
    // SERVING the chat (migration 105), so a routed chat's count here too. Each person scored in the period is
    // counted once, on the day of their first score, and is hot if any of
    // their scores in the period was high or urgent.
    const quality = await db.query<{ bucket: string; scored: string; hot: string }>(
      `with person as (
         select la.contact_id, min(la.created_at) as first_at,
                bool_or(la.priority in ('high', 'urgent')) as hot
           from lead_assessments la
          where la.serving_organization_id = $1 and la.category <> 'inbound_pitch' and la.created_at >= ${START}
          group by la.contact_id
       )
       select ${BUCKET("person.first_at")} as bucket, count(*)::text as scored,
              count(*) filter (where person.hot)::text as hot
         from person
        group by 1`,
      args
    );

    const viewings = await db.query<{ bucket: string; booked: string; held: string; no_show: string; cancelled: string }>(
      `select ${BUCKET("b.starts_at")} as bucket,
              count(*) filter (where b.status <> 'cancelled')::text as booked,
              count(*) filter (where b.status = 'completed')::text as held,
              count(*) filter (where b.status = 'no_show')::text as no_show,
              count(*) filter (where b.status = 'cancelled')::text as cancelled
         from bookings b
        where b.organization_id = $1 and b.starts_at >= ${START} and b.starts_at <= now()
        group by 1`,
      args
    );

    const counts = await db.query<Record<string, string>>(
      `select
         (select count(*) from contacts ct where ${SERVED})::text as contacts_total,
         (select count(*) from contacts ct where ${SERVED} and ct.created_at >= ${START})::text as contacts_added,
         (select count(*) from contacts ct where ${SERVED} and nullif(trim(ct.lead_source), '') is not null)::text as contacts_with_source,
         (select count(*) from contacts ct where ${SERVED} and ct.reengagement_opted_out)::text as contacts_opted_out,
         (select count(*) from contacts ct where ${SERVED} and ct.not_a_customer_at is not null)::text as contacts_not_customer,
         (select count(*) from contacts ct where ${SERVED} and ct.email_campaigns_opted_out_at is not null)::text as contacts_email_opted_out,
         (select count(*) from broadcast_recipients br join broadcasts b on b.id = br.broadcast_id
           where b.organization_id = $1 and coalesce(br.sent_at, b.created_at) >= ${START}
             and br.status in ('sent', 'delivered'))::text as outreach_sent,
         (select count(*) from broadcast_recipients br join broadcasts b on b.id = br.broadcast_id
           where b.organization_id = $1 and coalesce(br.sent_at, b.created_at) >= ${START}
             and br.status = 'delivered')::text as outreach_delivered,
         (select count(*) from broadcast_recipients br join broadcasts b on b.id = br.broadcast_id
           where b.organization_id = $1 and coalesce(br.sent_at, b.created_at) >= ${START}
             and br.status = 'failed')::text as outreach_failed,
         (select count(*) from call_logs cl where cl.organization_id = $1 and cl.occurred_at >= ${START} and cl.outcome = 'answered')::text as calls_answered,
         (select count(*) from call_logs cl where cl.organization_id = $1 and cl.occurred_at >= ${START} and cl.outcome = 'no-answer')::text as calls_no_answer,
         (select count(*) from call_logs cl where cl.organization_id = $1 and cl.occurred_at >= ${START} and cl.outcome = 'voicemail')::text as calls_voicemail,
         (select count(*) from call_logs cl where cl.organization_id = $1 and cl.occurred_at >= ${START} and cl.outcome = 'busy')::text as calls_busy,
         (select count(*) from call_logs cl where cl.organization_id = $1 and cl.occurred_at >= ${START} and cl.outcome = 'failed')::text as calls_failed,
         (select count(*) from reengagement_attempts ra where ra.organization_id = $1 and ra.sent_at >= ${START})::text as re_sent,
         (select count(*) from reengagement_attempts ra where ra.organization_id = $1 and ra.sent_at >= ${START} and ra.outcome = 'replied')::text as re_replied,
         (select count(*) from reengagement_attempts ra where ra.organization_id = $1 and ra.sent_at >= ${START} and ra.outcome = 'opted_out')::text as re_opted_out,
         (select count(*) from reengagement_attempts ra where ra.organization_id = $1 and ra.cooldown_until > now())::text as re_in_cooldown,
         (select count(*) from lead_labels ll where ll.organization_id = $1 and ll.outcome = 'won'
             and coalesce(ll.updated_at, ll.created_at) >= ${START})::text as won,
         (select count(*) from tasks t where t.organization_id = $1 and t.created_at >= ${START})::text as tasks_created,
         (select count(*) from tasks t where t.organization_id = $1 and t.status = 'done' and t.completed_at >= ${START})::text as tasks_done,
         (select count(*) from tasks t where t.organization_id = $1 and t.status = 'open')::text as tasks_open,
         (select count(*) from tasks t where t.organization_id = $1 and t.status = 'open' and t.due_at < now())::text as tasks_overdue
        where $4::text is not null`,
      args
    );
    const n = (key: string) => Number(counts.rows[0]?.[key] ?? 0);

    // ---- leads, channels, sources, replies ----
    const byChannel: Record<string, number> = {};
    for (const lead of leads) byChannel[lead.channel] = (byChannel[lead.channel] ?? 0) + 1;

    const replyMs = (lead: (typeof leads)[number]) =>
      lead.reply_at ? lead.reply_at.getTime() - lead.first_in.getTime() : null;
    const answered = leads.filter((lead) => lead.reply_at !== null);

    // ---- the funnel: the same people, each at their first chat in the period ----
    const people = new Map<string, (typeof leads)[number]>();
    for (const lead of leads) {
      const seen = people.get(lead.contact_id);
      if (!seen || lead.first_in < seen.first_in) people.set(lead.contact_id, lead);
    }
    const cohort = [...people.values()];
    // A funnel narrows: each step counts the people who reached it AND every
    // step before it, so a share is never more than the whole. A lead who
    // booked a viewing without being hot is in the Viewings chart, not here.
    const reached = (n: number) =>
      cohort.filter((p) => [p.scored, p.hot, p.booked, p.held, p.won].slice(0, n).every(Boolean)).length;

    // ---- the workflow board (3 Nov 2026): cards created on or moved into each
    // step in the period, and the permits of the units advertised now ----
    const board = await db.query<{ to_step: string; n: number }>(
      `select m.to_step, count(*)::int as n
         from workflow_moves m
        where m.organization_id = $1 and m.kind in ('created', 'moved')
          and m.at >= ${START} and $4::text is not null
        group by m.to_step`,
      args
    );
    const permits = await db.query<{ advertised: number; expired: number }>(
      `select count(*)::int as advertised,
              count(*) filter (where u.permit_expires_on < (now() at time zone $2)::date)::int as expired
         from property_units u
        where u.organization_id = $1 and u.step in ('S9', 'S10') and u.closed_at is null
          and $3::int is not null and $4::text is not null`,
      args
    );

    return {
      business: { slug: input.slug, name: input.name, timezone: input.timezone },
      period: { days: input.days, from: fromDay, today, bucket },
      evidence: {
        contacts: {
          total: n("contacts_total"),
          added: n("contacts_added"),
          withSource: n("contacts_with_source"),
          optedOut: n("contacts_opted_out"),
          notACustomer: n("contacts_not_customer"),
          emailOptedOut: n("contacts_email_opted_out"),
        },
        outreach: { sent: n("outreach_sent"), delivered: n("outreach_delivered"), failed: n("outreach_failed") },
        calls: {
          answered: n("calls_answered"),
          noAnswer: n("calls_no_answer"),
          voicemail: n("calls_voicemail"),
          busy: n("calls_busy"),
          failed: n("calls_failed"),
        },
        reengagement: {
          sent: n("re_sent"),
          replied: n("re_replied"),
          optedOut: n("re_opted_out"),
          inCooldown: n("re_in_cooldown"),
        },
        leads: { total: leads.length, pitches, byChannel, bySource: topSources(leads) },
        qualifier: {
          scored: quality.rows.reduce((sum, row) => sum + Number(row.scored), 0),
          hot: quality.rows.reduce((sum, row) => sum + Number(row.hot), 0),
        },
        replies: {
          medianMs: median(answered.map((lead) => replyMs(lead)!)),
          byAi: answered.filter((lead) => lead.reply_by === "ai_agent").length,
          byPerson: answered.filter((lead) => lead.reply_by === "human_agent").length,
          unanswered: leads.length - answered.length,
        },
        viewings: {
          booked: viewings.rows.reduce((sum, row) => sum + Number(row.booked), 0),
          held: viewings.rows.reduce((sum, row) => sum + Number(row.held), 0),
          noShow: viewings.rows.reduce((sum, row) => sum + Number(row.no_show), 0),
          cancelled: viewings.rows.reduce((sum, row) => sum + Number(row.cancelled), 0),
        },
        won: n("won"),
        followUps: {
          created: n("tasks_created"),
          done: n("tasks_done"),
          openNow: n("tasks_open"),
          overdueNow: n("tasks_overdue"),
        },
        board: Object.fromEntries(board.rows.map((row) => [row.to_step, row.n])),
        permits: { advertised: permits.rows[0]?.advertised ?? 0, expired: permits.rows[0]?.expired ?? 0 },
      },
      series: {
        leads: fillBuckets(
          keys.map((key) => ({ bucket: key, count: leads.filter((lead) => lead.bucket === key).length })),
          keys,
          (key) => ({ bucket: key, count: 0 })
        ),
        replyMedian: keys.map((key) => ({
          bucket: key,
          medianMs: median(answered.filter((lead) => lead.bucket === key).map((lead) => replyMs(lead)!)),
        })),
        quality: fillBuckets(
          quality.rows.map((row) => ({ bucket: row.bucket, scored: Number(row.scored), hot: Number(row.hot) })),
          keys,
          (key) => ({ bucket: key, scored: 0, hot: 0 })
        ),
        viewings: fillBuckets(
          viewings.rows.map((row) => ({
            bucket: row.bucket,
            booked: Number(row.booked),
            held: Number(row.held),
            noShow: Number(row.no_show),
            cancelled: Number(row.cancelled),
          })),
          keys,
          (key) => ({ bucket: key, booked: 0, held: 0, noShow: 0, cancelled: 0 })
        ),
      },
      funnel: {
        leads: cohort.length,
        scored: reached(1),
        hot: reached(2),
        booked: reached(3),
        held: reached(4),
        won: reached(5),
      },
    };
  });
}

/** The middle value, or the mean of the two middle ones; null for nothing. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * The six most common lead sources. A free-text field: "Bayut", " bayut " and
 * "BAYUT" are one source, shown in its most frequent spelling (ties broken by
 * plain character order, so the answer never depends on the database's
 * collation).
 */
function topSources(leads: { source_key: string | null; source_text: string | null }[]) {
  const groups = new Map<string, { count: number; spellings: Map<string, number> }>();
  for (const lead of leads) {
    if (!lead.source_key || !lead.source_text) continue;
    const group = groups.get(lead.source_key) ?? { count: 0, spellings: new Map<string, number>() };
    group.count += 1;
    group.spellings.set(lead.source_text, (group.spellings.get(lead.source_text) ?? 0) + 1);
    groups.set(lead.source_key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const spelling = [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0]![0];
      return { source: spelling, count: group.count };
    })
    .sort((a, b) => b.count - a.count || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))
    .slice(0, 6);
}
