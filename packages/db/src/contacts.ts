/**
 * The customer record. The "C" this platform did not have.
 *
 * ============================================================
 * WHAT WAS MISSING
 * ============================================================
 *
 * Fourteen screens, and not one of them showed a person. You could read a
 * conversation, a follow-up, a booking, a lead score — every artefact a
 * customer produces — and never the customer. Their history was spread across
 * five tables with no join anywhere that put it back together.
 *
 * Worse, and the reason this is not merely a convenience: `contact_memory`
 * holds what this platform has REMEMBERED about a person, and until now the
 * only readers were two verification scripts. Nobody could see what was held,
 * and `forgetContact` — whose own comment says it exists because "delete what
 * you hold about me is a request a customer can make, and an answer of 'we
 * would have to write some code' is not one" — had no caller outside a script.
 * The answer was still "we would have to run something".
 *
 * ============================================================
 * THE SHARED NUMBER, ONE MORE TIME
 * ============================================================
 *
 * A contact row is owned by the number's OWNER. Keying "who are this business's
 * customers" on `organization_id` offers Zipicka people who have only ever
 * spoken to Juris Prime, and offers Juris Prime nobody at all — the twelfth
 * instance of the defect this repository keeps finding.
 *
 * `served_organization_ids` is migration 055's answer, kept true by trigger,
 * and it is an ARRAY on purpose: the same person may ask the letting agent
 * about a flat and the law firm about a lease, and both should be able to
 * follow up. The predicate is defined once here and reused by everything that
 * asks the question, rather than written out a fourth time.
 */
import { getPool } from "./client.js";

/**
 * "Is this contact one of this business's customers?"
 *
 * A function of the placeholder rather than a constant, because the callers
 * number their parameters differently. The trailing fallback covers a contact
 * imported before they ever messaged, whose array is still empty.
 */
export function contactServedBy(param: string): string {
  return `(${param}::uuid = any (ct.served_organization_ids)
           or (cardinality(ct.served_organization_ids) = 0
               and ct.organization_id = ${param}))`;
}

export interface ContactSummary {
  id: string;
  waId: string;
  displayName: string | null;
  leadScore: number | null;
  leadPriority: string | null;
  leadCategory: string | null;
  lastMessageAt: string | null;
  conversations: number;
  /** True when this platform holds a remembered summary about them. */
  remembered: boolean;
  /** They asked not to be contacted again. Shown, never quietly honoured. */
  optedOut: boolean;
}

interface SummaryRow {
  id: string;
  wa_id: string;
  display_name: string | null;
  lead_score: number | null;
  lead_priority: string | null;
  lead_category: string | null;
  last_message_at: string | null;
  conversations: string;
  remembered: boolean;
  opted_out: boolean;
}

const toSummary = (row: SummaryRow): ContactSummary => ({
  id: row.id,
  waId: row.wa_id,
  displayName: row.display_name,
  leadScore: row.lead_score,
  leadPriority: row.lead_priority,
  leadCategory: row.lead_category,
  lastMessageAt: row.last_message_at,
  conversations: Number(row.conversations ?? 0),
  remembered: row.remembered,
  optedOut: row.opted_out,
});

/**
 * This business's customers, most recently heard from first.
 *
 * Ordered on last_message_at rather than lead score: the question a person
 * opens this screen with is "who have I been talking to", and a list sorted by
 * a number the scorer produced would put a data broker above a real customer
 * who wrote yesterday.
 */
export async function listContacts(
  organizationId: string,
  options: { search?: string; limit?: number } = {}
): Promise<ContactSummary[]> {
  const search = options.search?.trim().toLowerCase() ?? "";
  const like = search ? `%${search}%` : null;
  // Digits only, so "+971 50 123" finds a number stored without the spaces.
  const digits = search.replace(/[^0-9]/g, "");
  const digitLike = digits.length >= 3 ? `%${digits}%` : null;

  const { rows } = await getPool().query<SummaryRow>(
    `select ct.id, ct.wa_id, ct.display_name,
            ct.lead_score, ct.lead_priority, ct.lead_category,
            ct.last_message_at,
            ct.reengagement_opted_out as opted_out,
            (
              select count(*) from conversations c
               where c.contact_id = ct.id
                 and coalesce(c.routed_organization_id, c.organization_id) = $1
            ) as conversations,
            exists (
              select 1 from contact_memory cm
               where cm.contact_id = ct.id and cm.organization_id = $1
            ) as remembered
       from contacts ct
      where ${contactServedBy("$1")}
        and ($2::text is null
             or lower(coalesce(ct.display_name, '')) like $2
             or ($3::text is not null and ct.wa_id like $3))
      order by ct.last_message_at desc nulls last
      limit $4`,
    [organizationId, like, digitLike, options.limit ?? 100]
  );
  return rows.map(toSummary);
}

export interface ContactDetail extends ContactSummary {
  /** Which businesses on this number have ever served them. */
  servedBy: string[];
  /** Every assessment the scorer has made, newest first. */
  leadHistory: Array<{
    id: string;
    score: number;
    priority: string;
    category: string;
    createdAt: string;
  }>;
  conversationList: Array<{
    id: string;
    status: string;
    openedAt: string;
    lastMessageAt: string | null;
    messages: number;
  }>;
  openFollowUps: number;
  bookings: number;
}

/**
 * One customer, and everything this business is entitled to see about them.
 *
 * Scoped on the SERVING business throughout, not the number's owner. A Juris
 * Prime operator reading this must not be shown the conversations that person
 * had with the letting agent -- they are two different firms who happen to
 * share a phone number, which is the whole reason the egress policy exists.
 */
export async function getContact(
  organizationId: string,
  contactId: string
): Promise<ContactDetail | null> {
  const { rows } = await getPool().query<
    SummaryRow & { served_by: string[] | null }
  >(
    `select ct.id, ct.wa_id, ct.display_name,
            ct.lead_score, ct.lead_priority, ct.lead_category,
            ct.last_message_at,
            ct.reengagement_opted_out as opted_out,
            (
              select count(*) from conversations c
               where c.contact_id = ct.id
                 and coalesce(c.routed_organization_id, c.organization_id) = $1
            ) as conversations,
            exists (
              select 1 from contact_memory cm
               where cm.contact_id = ct.id and cm.organization_id = $1
            ) as remembered,
            (
              select array_agg(o.slug order by o.slug)
                from organizations o
               where o.id = any (ct.served_organization_ids)
            ) as served_by
       from contacts ct
      where ct.id = $2 and ${contactServedBy("$1")}`,
    [organizationId, contactId]
  );
  if (!rows[0]) return null;

  const [leads, conversations, followUps, bookings] = await Promise.all([
    getPool().query<{
      id: string;
      score: number;
      priority: string;
      category: string;
      created_at: string;
    }>(
      `select id, score, priority, category, created_at
         from lead_assessments
        where contact_id = $2 and organization_id = $1
        order by created_at desc limit 20`,
      [organizationId, contactId]
    ),
    getPool().query<{
      id: string;
      status: string;
      opened_at: string;
      last_message_at: string | null;
      messages: string;
    }>(
      `select c.id, c.status, c.opened_at,
              (select max(m.created_at) from messages m where m.conversation_id = c.id) as last_message_at,
              (select count(*) from messages m where m.conversation_id = c.id) as messages
         from conversations c
        where c.contact_id = $2
          and coalesce(c.routed_organization_id, c.organization_id) = $1
        order by c.opened_at desc limit 20`,
      [organizationId, contactId]
    ),
    getPool().query<{ n: string }>(
      `select count(*) as n from tasks t
        join conversations c on c.id = t.conversation_id
       where c.contact_id = $2 and t.organization_id = $1 and t.status = 'open'`,
      [organizationId, contactId]
    ),
    getPool().query<{ n: string }>(
      `select count(*) as n from bookings where contact_id = $2 and organization_id = $1`,
      [organizationId, contactId]
    ),
  ]);

  return {
    ...toSummary(rows[0]),
    servedBy: rows[0].served_by ?? [],
    leadHistory: leads.rows.map((r) => ({
      id: r.id,
      score: r.score,
      priority: r.priority,
      category: r.category,
      createdAt: r.created_at,
    })),
    conversationList: conversations.rows.map((r) => ({
      id: r.id,
      status: r.status,
      openedAt: r.opened_at,
      lastMessageAt: r.last_message_at,
      messages: Number(r.messages ?? 0),
    })),
    openFollowUps: Number(followUps.rows[0]?.n ?? 0),
    bookings: Number(bookings.rows[0]?.n ?? 0),
  };
}

/**
 * Is this contact one this business may act on at all?
 *
 * Used before a write -- forgetting, in particular -- so that a mistyped id
 * cannot reach another firm's customer. RLS would stop the read; this makes the
 * refusal explicit and the same shape as every other authorisation here.
 */
export async function contactBelongsToBusiness(
  organizationId: string,
  contactId: string
): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `select true as ok from contacts ct
      where ct.id = $2 and ${contactServedBy("$1")}`,
    [organizationId, contactId]
  );
  return rows.length > 0;
}
