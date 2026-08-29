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
import { withTenant } from "./client.js";

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
 * Counted from `broadcast_recipients` — rows that were actually queued — rather
 * than from anything the campaign intended. A cap enforced against intent is
 * not a cap; the recipient rows are what cost money and what moved the shared
 * number's quality rating.
 */
export async function broadcastAllowanceRemaining(
  employeeId: string,
  monthlyCap: number
): Promise<{ used: number; cap: number; remaining: number }> {
  const { rows } = await getPool().query<{ used: string }>(
    `select count(r.id) as used
       from broadcast_recipients r
       join broadcasts b on b.id = r.broadcast_id
      where b.employee_id = $1
        and b.created_at >= date_trunc('month', now())`,
    [employeeId]
  );
  const used = Number(rows[0]?.used ?? 0);
  return { used, cap: monthlyCap, remaining: Math.max(0, monthlyCap - used) };
}
