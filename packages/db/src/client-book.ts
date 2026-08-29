/**
 * A staff member's own client book.
 *
 * ============================================================
 * TWO POOLS, ONE TABLE
 * ============================================================
 *
 * Every contact this platform has ever held belongs to the business: anyone who
 * messaged the shared number and was routed somewhere. `owner_employee_id` adds
 * a second, smaller pool on the same table — people a named staff member
 * brought with them, who are theirs to keep and theirs to message.
 *
 * The distinction is not decoration. A staff member's book is the thing they
 * would take to another job, and a colleague browsing it is the thing they
 * would object to. So the rule is narrow and stated once:
 *
 *   - owner_employee_id IS NULL  → the business's pool. Every colleague sees it.
 *   - owner_employee_id = me     → mine. Only I and the owner see it.
 *   - owner_employee_id = anyone else → invisible to me entirely.
 *
 * The operator sees all of it, because the operator sees everything; that is
 * what being the owner of the platform means, and pretending otherwise would
 * only mean the owner could not answer a customer complaint about their own
 * business.
 *
 * ============================================================
 * WHY A PREDICATE AND NOT A POLICY
 * ============================================================
 *
 * Row-level security here keys on `app.current_org`. An employee-level policy
 * would have to pass when no employee is set — every worker and webhook path
 * runs that way — so one forgotten `set_config` in the API would show one
 * person another's book with nothing raised anywhere. Migration 073 records
 * that reasoning at length.
 *
 * Instead the predicate lives here, once, and a gate fails the build when a
 * query that reads a client book omits it. Same shape as `contactServedBy`,
 * for the same reason, after the same bug.
 */
import { getPool } from "./client.js";
import { contactServedBy } from "./contacts.js";
import { ensureContactForServingBusiness } from "./contact-identity.js";
import { withTenant, withAllTenants } from "./client.js";

/**
 * "May this person see this contact?"
 *
 * A function of the placeholder because callers number their parameters
 * differently — and deliberately NOT a function that takes an employee id
 * directly, because building SQL from a value is how an id becomes an
 * injection. The caller passes `$3`; the value goes in the parameter array.
 *
 * Pass a placeholder that resolves to NULL for an operator: the first branch is
 * then true for every row, which is the operator's whole point.
 */
export function contactVisibleTo(employeeParam: string): string {
  return `(${employeeParam}::uuid is null
           or ct.owner_employee_id is null
           or ct.owner_employee_id = ${employeeParam}::uuid)`;
}

/** "Is this contact specifically mine?" — the book itself, not the pool. */
export function contactOwnedBy(employeeParam: string): string {
  return `(ct.owner_employee_id = ${employeeParam}::uuid)`;
}

export interface ClientRow {
  id: string;
  waId: string;
  displayName: string | null;
  note: string | null;
  company: string | null;
  lastMessageAt: string | null;
  optedOut: boolean;
  /** Have they ever actually written in? An imported number has not. */
  hasSpoken: boolean;
}

interface Row {
  id: string;
  wa_id: string;
  display_name: string | null;
  attributes: Record<string, unknown>;
  last_message_at: Date | null;
  opted_out: boolean;
  has_spoken: boolean;
}

const toClient = (row: Row): ClientRow => ({
  id: row.id,
  waId: row.wa_id,
  displayName: row.display_name,
  // Free-text details live in `attributes` rather than in new columns. A client
  // book accumulates fields nobody predicted — a job title here, a referral
  // source there — and each one as a column is a migration per idea.
  note: typeof row.attributes?.note === "string" ? row.attributes.note : null,
  company: typeof row.attributes?.company === "string" ? row.attributes.company : null,
  lastMessageAt: row.last_message_at?.toISOString() ?? null,
  optedOut: row.opted_out,
  hasSpoken: row.has_spoken,
});

/** Everyone in this person's own book, newest contact first. */
export async function listMyClients(
  organizationId: string,
  employeeId: string,
  options: { search?: string; limit?: number } = {}
): Promise<ClientRow[]> {
  const search = options.search?.trim().toLowerCase() ?? "";
  const like = search ? `%${search}%` : null;
  const digits = search.replace(/[^0-9]/g, "");
  const digitLike = digits.length >= 3 ? `%${digits}%` : null;

  const { rows } = await getPool().query<Row>(
    `select ct.id, ct.wa_id, ct.display_name, ct.attributes,
            ct.last_message_at,
            ct.reengagement_opted_out as opted_out,
            (ct.last_message_at is not null) as has_spoken
       from contacts ct
      where ${contactServedBy("$1")}
        and ${contactOwnedBy("$2")}
        and ($3::text is null
             or lower(coalesce(ct.display_name, '')) like $3
             or ($4::text is not null and ct.wa_id like $4))
      order by ct.last_message_at desc nulls last, ct.created_at desc
      limit $5`,
    [organizationId, employeeId, like, digitLike, options.limit ?? 200]
  );
  return rows.map(toClient);
}

export interface AddClientInput {
  organizationId: string;
  employeeId: string;
  waId: string;
  displayName: string;
  company?: string | null;
  note?: string | null;
}

export type AddClientResult =
  | { ok: true; client: ClientRow }
  | { ok: false; reason: "already-yours" | "already-someone-elses" | "already-the-business"; heldBy?: string };

/**
 * Put somebody in this person's book.
 *
 * ============================================================
 * THE COLLISION THAT WILL HAPPEN
 * ============================================================
 *
 * `contacts` is unique on (organization_id, wa_id), so the second staff member
 * to add the same person does not get a second row — they get a constraint
 * violation, or, if this were written carelessly, somebody else's client
 * silently reassigned to them.
 *
 * Reassignment is the wrong answer and it is the easy one to write. A client
 * book is a relationship; moving one because a colleague typed a number is a
 * theft the colleague did not intend and the owner never sees. So a collision
 * REFUSES, and says which of the three kinds it is, because the three need
 * different things from the person reading:
 *
 *   already-yours          → they already have them; nothing to do.
 *   already-the-business   → the person has messaged the shared number before.
 *                            Claiming them is a real decision, so it is a
 *                            separate deliberate action, not a side effect.
 *   already-someone-elses  → a colleague's client. Named, because within one
 *                            business "go and talk to Aqib" is the useful
 *                            answer and anonymity here helps nobody.
 */
export async function addClient(input: AddClientInput): Promise<AddClientResult> {
  const pool = getPool();

  // Asked with the SERVING predicate, not organization_id. On a shared number a
  // contact row belongs to the number's OWNER, so keying this on the staff
  // member's own business would find nobody, report the person as new, and then
  // collide on insert -- the fourteenth instance of the defect this repository
  // keeps finding, caught by its own gate before it shipped.
  const existing = await pool.query<{ owner: string | null; owner_name: string | null }>(
    `select ct.owner_employee_id as owner, e.full_name as owner_name
       from contacts ct
       left join employees e on e.id = ct.owner_employee_id
      where ${contactServedBy("$1")} and ct.wa_id = $2`,
    [input.organizationId, input.waId]
  );

  if (existing.rows.length > 0) {
    const owner = existing.rows[0].owner;
    if (owner === input.employeeId) return { ok: false, reason: "already-yours" };
    if (owner === null) return { ok: false, reason: "already-the-business" };
    return {
      ok: false,
      reason: "already-someone-elses",
      heldBy: existing.rows[0].owner_name ?? "another colleague",
    };
  }

  // Created through the shared identity path rather than a raw insert here.
  // That function writes the row under the number's owner -- keyed exactly as
  // the webhook keys it, so an inbound message from this person lands ON this
  // row rather than beside it -- and opens a conversation routed to the serving
  // business, which is what makes the trigger fill served_organization_ids.
  // A direct insert would produce a client the staff member could add and then
  // never find again.
  const ensured = await ensureContactForServingBusiness({
    servingOrganizationId: input.organizationId,
    waId: input.waId,
    displayName: input.displayName,
    capturedByEmployeeId: input.employeeId,
  });

  const { rows } = await withTenant(ensured.ownerOrganizationId, () =>
    pool.query<Row>(
      `update contacts ct
          set owner_employee_id = $2,
              attributes = jsonb_strip_nulls(
                ct.attributes
                  || jsonb_build_object('company', $3::text)
                  || jsonb_build_object('note', $4::text)
              ),
              updated_at = now()
        where ct.id = $1
        returning ct.id, ct.wa_id, ct.display_name, ct.attributes, ct.last_message_at,
                  ct.reengagement_opted_out as opted_out,
                  (ct.last_message_at is not null) as has_spoken`,
      [ensured.contactId, input.employeeId, input.company ?? null, input.note ?? null]
    )
  );
  return { ok: true, client: toClient(rows[0]) };
}

/**
 * Take a contact out of the shared pool into somebody's book.
 *
 * Separate from `addClient` because it is a different act: the person already
 * exists and has history with the business, and one staff member is now
 * answerable for them. Refuses to take one that is already somebody's, so this
 * can never become a way to move a colleague's client sideways.
 */
export async function claimClient(
  organizationId: string,
  employeeId: string,
  contactId: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update contacts ct
        set owner_employee_id = $2, updated_at = now()
      where ct.id = $3
        and ${contactServedBy("$1")}
        and ct.owner_employee_id is null`,
    [organizationId, employeeId, contactId]
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Hand somebody back to the business pool.
 *
 * Only ever back to NULL, never straight to a named colleague. Handing a client
 * to somebody who has not agreed to take them produces a book with a name on it
 * that nobody is reading -- the same failure as a rota nobody watches, and the
 * business pool is the honest place for a client between owners.
 */
export async function releaseClient(
  organizationId: string,
  employeeId: string,
  contactId: string
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update contacts ct
        set owner_employee_id = null, updated_at = now()
      where ct.id = $3
        and ${contactServedBy("$1")}
        and ${contactOwnedBy("$2")}`,
    [organizationId, employeeId, contactId]
  );
  return (rowCount ?? 0) > 0;
}

/** Edit the details a staff member keeps on their own client. */
export async function updateClientDetails(
  organizationId: string,
  employeeId: string,
  contactId: string,
  patch: { displayName?: string; company?: string | null; note?: string | null }
): Promise<ClientRow | null> {
  const { rows } = await getPool().query<Row>(
    `update contacts ct
        set display_name = coalesce($4, ct.display_name),
            attributes = jsonb_strip_nulls(
              ct.attributes
                || jsonb_build_object('company', $5::text)
                || jsonb_build_object('note', $6::text)
            ),
            updated_at = now()
      where ct.id = $3
        and ${contactServedBy("$1")}
        and ${contactOwnedBy("$2")}
      returning ct.id, ct.wa_id, ct.display_name, ct.attributes, ct.last_message_at,
                ct.reengagement_opted_out as opted_out,
                (ct.last_message_at is not null) as has_spoken`,
    [
      organizationId,
      employeeId,
      contactId,
      patch.displayName ?? null,
      patch.company ?? null,
      patch.note ?? null,
    ]
  );
  return rows[0] ? toClient(rows[0]) : null;
}

/**
 * How many people this person may still reach this calendar month.
 *
 * ============================================================
 * NULL IS NOT ZERO, AND IT IS NOT INFINITY EITHER
 * ============================================================
 *
 * A null cap means this platform sets no ceiling — the owner's decision, made
 * knowingly. It does NOT mean the sender can reach everybody: Meta caps the
 * number at its messaging tier regardless, and that cap is shared by every
 * business on it. `remaining` is null in that case rather than a large number,
 * so nothing downstream can print a limit nobody chose or compare against one.
 *
 * `used` is still counted, because "how many have I sent this month" is a
 * question worth answering whether or not anything is enforcing it.
 *
 * Counted from `broadcast_recipients` — rows that were actually queued — rather
 * than from anything a campaign intended. A cap enforced against intent is not
 * a cap, and a count reported from intent is not a count.
 */
export async function broadcastAllowanceRemaining(
  employeeId: string,
  monthlyCap: number | null
): Promise<{ used: number; cap: number | null; remaining: number | null }> {
  const { rows } = await getPool().query<{ used: string }>(
    `select count(r.id) as used
       from broadcast_recipients r
       join broadcasts b on b.id = r.broadcast_id
      where b.employee_id = $1
        and b.created_at >= date_trunc('month', now())`,
    [employeeId]
  );
  const used = Number(rows[0]?.used ?? 0);
  return {
    used,
    cap: monthlyCap,
    remaining: monthlyCap === null ? null : Math.max(0, monthlyCap - used),
  };
}


/**
 * Record that a number on the business account is this person's.
 *
 * ============================================================
 * ONE NUMBER, ONE OWNER
 * ============================================================
 *
 * Two staff members claiming the same phone_number_id would each believe their
 * messages were private while both sent from the same line, and inbound routing
 * -- which keys on exactly this column -- would have two answers to a question
 * that must have one. So this refuses when the number is already spoken for,
 * rather than taking it.
 *
 * The claim is only ever recorded AFTER the number has been found on the
 * business account at Meta. This function does not check that; its caller does,
 * because the check is a network call and this is a transaction.
 */
export async function claimPhoneNumber(input: {
  organizationId: string;
  employeeId: string;
  phoneNumberId: string;
  displayNumber: string;
  verifiedName: string;
  qualityRating: string | null;
}): Promise<{ ok: true } | { ok: false; heldBy: string }> {
  const pool = getPool();

  const taken = await pool.query<{ full_name: string }>(
    `select full_name from employees
      where whatsapp_phone_number_id = $1 and id <> $2 and is_active`,
    [input.phoneNumberId, input.employeeId]
  );
  if (taken.rows[0]) return { ok: false, heldBy: taken.rows[0].full_name };

  await pool.query(
    `update employees
        set whatsapp_phone_number_id = $2,
            whatsapp_number = $3,
            whatsapp_verified_name = $4,
            whatsapp_quality_rating = $5,
            whatsapp_connected_at = now()
      where id = $1 and organization_id = $6`,
    [
      input.employeeId,
      input.phoneNumberId,
      input.displayNumber.replace(/\D/g, ""),
      input.verifiedName,
      input.qualityRating,
      input.organizationId,
    ]
  );
  return { ok: true };
}

/**
 * Give a number back.
 *
 * Leaves `whatsapp_number` alone: that is how colleagues reach the person, and
 * it was on file long before any of this. Only the API binding is released.
 */
export async function releasePhoneNumber(
  organizationId: string,
  employeeId: string
): Promise<void> {
  await getPool().query(
    `update employees
        set whatsapp_phone_number_id = null,
            whatsapp_verified_name = null,
            whatsapp_quality_rating = null,
            whatsapp_connected_at = null
      where id = $1 and organization_id = $2`,
    [employeeId, organizationId]
  );
}

/**
 * A campaign a staff member owns, to their own book.
 *
 * Separate from `createBroadcast` rather than a flag on it, because the two
 * differ in the thing that matters: whose audience it is. A business campaign
 * resolves its audience from a filter over every contact the business serves; a
 * staff campaign can only ever reach rows this person owns, and that is a
 * property of the function rather than of the arguments passed to it.
 *
 * `from_phone_number_id` is stamped now and never recomputed. Asked later, "what
 * did this go out from" must not change because somebody was reassigned.
 */
export async function createStaffBroadcast(input: {
  organizationId: string;
  employeeId: string;
  templateId: string;
  fromPhoneNumberId: string;
}): Promise<{ id: string }> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into broadcasts
       (organization_id, template_id, audience_filter, status, employee_id, from_phone_number_id)
     values ($1, $2, '{"scope":"my-clients"}'::jsonb, 'draft', $3, $4)
     returning id`,
    [input.organizationId, input.templateId, input.employeeId, input.fromPhoneNumberId]
  );
  return { id: rows[0].id };
}

/**
 * Who a staff campaign would actually reach.
 *
 * ============================================================
 * THREE REASONS SOMEBODY IS NOT IN HERE
 * ============================================================
 *
 * Owned by this person, served by this business, and not opted out. The last is
 * not a nicety: `reengagement_opted_out` is set when somebody has asked to be
 * left alone, and a client book is exactly where that request is easiest to
 * forget — these are people the sender knows, so the sender feels entitled.
 *
 * Contacts who have never written in ARE included. They were added by hand,
 * which is the whole point of the book, and a template message is the only
 * thing that may be sent to them anyway.
 */
export async function myClientsForBroadcast(
  organizationId: string,
  employeeId: string
): Promise<Array<{ id: string; waId: string; displayName: string | null }>> {
  const { rows } = await getPool().query<{ id: string; wa_id: string; display_name: string | null }>(
    `select ct.id, ct.wa_id, ct.display_name
       from contacts ct
      where ${contactServedBy("$1")}
        and ${contactOwnedBy("$2")}
        and ct.reengagement_opted_out = false
      order by ct.display_name nulls last`,
    [organizationId, employeeId]
  );
  return rows.map((row) => ({ id: row.id, waId: row.wa_id, displayName: row.display_name }));
}

/** Every campaign this person has run, newest first. */
export async function listMyBroadcasts(
  employeeId: string
): Promise<
  Array<{
    id: string;
    status: string;
    createdAt: string;
    templateName: string | null;
    sent: number;
    failed: number;
    total: number;
  }>
> {
  const { rows } = await getPool().query<{
    id: string;
    status: string;
    created_at: string;
    template_name: string | null;
    sent: string;
    failed: string;
    total: string;
  }>(
    `select b.id, b.status, b.created_at, t.meta_template_name as template_name,
            count(r.id) filter (where r.status in ('sent', 'delivered')) as sent,
            count(r.id) filter (where r.status = 'failed') as failed,
            count(r.id) as total
       from broadcasts b
       left join message_templates t on t.id = b.template_id
       left join broadcast_recipients r on r.broadcast_id = b.id
      where b.employee_id = $1
      group by b.id, t.meta_template_name
      order by b.created_at desc
      limit 50`,
    [employeeId]
  );
  return rows.map((row) => ({
    id: row.id,
    status: row.status,
    createdAt: row.created_at,
    templateName: row.template_name,
    sent: Number(row.sent),
    failed: Number(row.failed),
    total: Number(row.total),
  }));
}

/**
 * Record that somebody has asked not to be messaged.
 *
 * ============================================================
 * WHY THIS IS NOT PER-BUSINESS
 * ============================================================
 *
 * `reengagement_opted_out` sits on the contact, and a contact is one row shared
 * by every business answering on the number. So opting out of Zipicka's
 * promotions opts the person out of all six.
 *
 * That looks like a limitation and is in fact the honest reading. The customer
 * sees ONE WhatsApp number. They did not know they were talking to six
 * companies, they cannot tell which one sent the message they are objecting to,
 * and "stop" from somebody who believes they are talking to one business means
 * stop. Splitting it per business would keep messaging a person who has already
 * said no, from what they experience as the same sender.
 *
 * Written under the contact's OWNING tenant — the number's owner — because that
 * is the only scope in which the contacts policy's WITH CHECK passes.
 */
export async function optOutOfReengagement(contactId: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update contacts
        set reengagement_opted_out = true, updated_at = now()
      where id = $1 and reengagement_opted_out = false`,
    [contactId]
  );
  // False means already opted out, not a failure. The caller still confirms to
  // the customer: somebody who says stop twice deserves an answer both times.
  return (rowCount ?? 0) > 0;
}

/**
 * How many people this NUMBER has already started a conversation with today.
 *
 * ============================================================
 * THE CEILING THAT IS REAL
 * ============================================================
 *
 * Meta limits a number to its messaging tier — 250 unique customers in any
 * rolling 24 hours while the business is unverified — and that limit belongs to
 * the NUMBER, not to a business or a person. Six businesses and every staff
 * member share it. A campaign larger than what is left does not fail loudly; it
 * queues, sends until the ceiling, and the rest quietly do not arrive.
 *
 * Counted CROSS-TENANT for exactly that reason. Scoped to one business this
 * would return a fraction of the true figure and read as plenty of headroom.
 *
 * Business-initiated messages are what the tier counts, so this counts
 * broadcast recipients. It is a floor, not the exact number Meta holds — a
 * re-engagement message or a template sent outside a campaign is not in here —
 * and it is described that way wherever it is shown. A floor that is honest
 * about being a floor beats a precise number that is wrong.
 */
export async function dailyReachUsed(): Promise<number> {
  return withAllTenants("daily reach: a ceiling that belongs to the number, not a tenant", async () => {
    const { rows } = await getPool().query<{ n: string }>(
      `select count(distinct r.contact_id) as n
         from broadcast_recipients r
        where r.created_at >= now() - interval '24 hours'
          and r.status <> 'failed'`
    );
    return Number(rows[0]?.n ?? 0);
  });
}
