import { getPool } from "./client.js";

/**
 * One search across the things an operator actually looks for.
 *
 * The header carried a search box with no handler for as long as the console
 * has existed. What it should find is not "everything" — it is the three
 * questions people actually arrive with:
 *
 *   "what did that customer say"      → a contact, and the conversation to open
 *   "what did we promise them"        → a follow-up
 *   "who is this number"              → a contact by wa_id
 *
 * Deliberately NOT full-text over message bodies. Postgres would need a
 * tsvector index to do that without a sequential scan over every message ever
 * sent, and a search that quietly degrades as the table grows is worse than one
 * that admits its scope. Names, numbers and commitments are what people search
 * by; message archaeology is what the conversation view is for.
 */

export type SearchKind = "contact" | "task";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  detail: string | null;
  businessName: string;
  businessSlug: string;
  /** Where clicking it goes. */
  href: string;
}

interface ContactRow {
  id: string;
  display_name: string | null;
  wa_id: string;
  business_name: string;
  business_slug: string;
  conversation_id: string | null;
  last_message_at: string | null;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  due_at: string | null;
  business_name: string;
  business_slug: string;
  contact_name: string | null;
}

/**
 * `organizationId` null means every business — the operator's view. An employee
 * always passes their own, and the ROUTE is what enforces that: this function
 * will happily search everything if asked, which is why it is never called with
 * a value the caller did not derive from the session.
 *
 * The term is matched case-insensitively against names and against wa_id with
 * non-digits stripped, so "+971 50 480 5436", "971504805436" and "0504805436"
 * all find the same person. Somebody searching a phone number has copied it
 * from somewhere, and it will not be formatted the way the database stores it.
 */
export async function search(
  term: string,
  organizationId: string | null,
  limit = 8
): Promise<SearchHit[]> {
  const trimmed = term.trim();
  // Two characters is the floor. One letter matches most of the database and
  // returns a list nobody can use.
  if (trimmed.length < 2) return [];

  const like = `%${trimmed.toLowerCase()}%`;
  const digits = trimmed.replace(/\D/g, "");
  // Only treated as a phone number when there are enough digits to be one.
  // Otherwise "1" would match every wa_id containing a 1, which is all of them.
  const digitLike = digits.length >= 4 ? `%${digits}%` : null;

  const [contacts, tasks] = await Promise.all([
    getPool().query<ContactRow>(
      `select ct.id, ct.display_name, ct.wa_id,
              -- LABELLED BY WHO IS TALKING TO THEM, not who owns the row.
              --
              -- A contact belongs to the number's owner, because it is created
              -- when the message arrives and before anybody knows which of the
              -- five firms is being asked for. Reading the label off
              -- ct.organization_id put "Zipicka" beside every routed customer,
              -- including on an operator's global search where the label is the
              -- only thing distinguishing five businesses' customers from each
              -- other.
              --
              -- Taken from the conversation rather than from the contact's
              -- served set, because a person who asks the letting agent about a
              -- flat and the law firm about a lease belongs to both, and a
              -- single label has to pick one. The most recent conversation is
              -- the one somebody searching is looking for.
              o.name as business_name, o.slug as business_slug,
              c.id  as conversation_id,
              lm.created_at as last_message_at
         from contacts ct
         left join lateral (
           select id, coalesce(routed_organization_id, organization_id) as serving
             from conversations
            where contact_id = ct.id
            order by opened_at desc
            limit 1
         ) c on true
         join organizations o on o.id = coalesce(c.serving, ct.organization_id)
         left join lateral (
           select created_at from messages
            where contact_id = ct.id
            order by created_at desc
            limit 1
         ) lm on true
        -- FOUND BY THE FIRM THAT IS SERVING THEM. Keyed on ct.organization_id,
        -- an employee of Juris Prime searching for their own customer by name
        -- got nothing at all -- the same emptiness the inbox had before
        -- migration 055, left behind because that fix reached the inbox and not
        -- this. The array is 055's, kept true by trigger; the fallback covers a
        -- contact imported before they ever messaged.
        where ($2::uuid is null
               or $2::uuid = any (ct.served_organization_ids)
               or (cardinality(ct.served_organization_ids) = 0
                   and ct.organization_id = $2))
          and (lower(coalesce(ct.display_name, '')) like $1
               or ($3::text is not null and ct.wa_id like $3))
        order by lm.created_at desc nulls last
        limit $4`,
      [like, organizationId, digitLike, limit]
    ),
    getPool().query<TaskRow>(
      `select t.id, t.title, t.status, t.due_at,
              o.name as business_name, o.slug as business_slug,
              ct.display_name as contact_name
         from tasks t
         join organizations o on o.id = t.organization_id
         left join contacts ct on ct.id = t.contact_id
        where ($2::uuid is null or t.organization_id = $2)
          and lower(t.title) like $1
        order by case when t.status = 'open' then 0 else 1 end,
                 t.due_at asc nulls last
        limit $3`,
      [like, organizationId, limit]
    ),
  ]);

  const contactHits: SearchHit[] = contacts.rows.map((row) => ({
    kind: "contact",
    id: row.id,
    title: row.display_name ?? `+${row.wa_id}`,
    // The number is shown even when there is a name, because that is often the
    // thing being checked — "is this the same person who messaged yesterday".
    detail: row.display_name ? `+${row.wa_id}` : null,
    businessName: row.business_name,
    businessSlug: row.business_slug,
    href: "/inbox",
  }));

  const taskHits: SearchHit[] = tasks.rows.map((row) => ({
    kind: "task",
    id: row.id,
    title: row.title,
    detail:
      (row.status === "open" ? "Open" : row.status === "done" ? "Done" : "Cancelled") +
      (row.contact_name ? ` · ${row.contact_name}` : ""),
    businessName: row.business_name,
    businessSlug: row.business_slug,
    href: "/deck/tasks",
  }));

  // People before promises: someone typing a name wants the person, and a
  // follow-up mentioning that name is the less likely target.
  return [...contactHits, ...taskHits].slice(0, limit);
}
