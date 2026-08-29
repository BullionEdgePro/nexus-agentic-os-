/**
 * Turning a tag in a message into a person, and a lead.
 *
 * Everything here runs inside the SERVING business's tenant scope — the
 * business the conversation was routed to — because that is who the staff
 * member works for. A staff code is unique per business, never globally, so
 * resolving one without a business would find whichever colleague at whichever
 * company happened to share the code.
 */
import { getPool, withServingTenant } from "./client.js";
import { contactServedBy } from "./contacts.js";
import { contactOwnedBy } from "./client-book.js";

export interface ReferringEmployee {
  id: string;
  employeeCode: string;
  fullName: string;
  whatsappNumber: string | null;
  isActive: boolean;
}

/**
 * The colleague a `#via-` tag names, within one business.
 *
 * Inactive staff are returned rather than filtered out, and the caller decides.
 * A link belonging to somebody who has left still tells you where the lead came
 * from, which is worth recording; what it must not do is promise the customer a
 * handover to a person who no longer works there.
 */
export async function findEmployeeByCode(
  organizationId: string,
  employeeCode: string
): Promise<ReferringEmployee | null> {
  // WRAPPED, AND THIS IS THE WHOLE REASON THE FUNCTION EXISTS RATHER THAN AN
  // INLINE QUERY.
  //
  // `employees` is isolated on `organization_id = app.current_org` with no
  // serving clause at all. The inbound worker runs in the NUMBER OWNER's scope,
  // so asking it for a colleague at the business the conversation was routed to
  // returns zero rows and no error -- every referral to any business but the
  // number's owner would silently attribute to nobody, and the symptom would be
  // "the tag does not work sometimes".
  //
  // The scoping lives in here so no caller can forget it, which is how
  // hasActiveEmployees solved the identical problem.
  return withServingTenant(organizationId, () => findEmployeeByCodeScoped(organizationId, employeeCode));
}

async function findEmployeeByCodeScoped(
  organizationId: string,
  employeeCode: string
): Promise<ReferringEmployee | null> {
  const { rows } = await getPool().query<{
    id: string;
    employee_code: string;
    full_name: string;
    whatsapp_number: string | null;
    is_active: boolean;
  }>(
    `select id, employee_code, full_name, whatsapp_number, is_active
       from employees
      where organization_id = $1 and lower(employee_code) = lower($2)`,
    [organizationId, employeeCode]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    employeeCode: row.employee_code,
    fullName: row.full_name,
    whatsappNumber: row.whatsapp_number,
    isActive: row.is_active,
  };
}

export interface AttributionResult {
  /** The conversation now records where it came from. */
  recorded: boolean;
  /** The contact entered this person's client book. */
  claimed: boolean;
  /** Somebody else already owns this contact; nothing was moved. */
  conflictWith: string | null;
}

/**
 * Record that this conversation arrived through somebody's link.
 *
 * ============================================================
 * WRITTEN ONCE, DELIBERATELY
 * ============================================================
 *
 * `referred_by_employee_id is null` guards the update, so a customer who sends
 * the prefilled text twice, or quotes their own first message later, does not
 * rewrite the origin of a conversation that already has one. The first link
 * wins because the first link is the one that actually brought them.
 *
 * The assignment (`employee_id`) is set at the same time and by the same guard,
 * but is free to move afterwards — that is the difference between the two
 * columns and the reason there are two.
 */
export async function attributeConversation(input: {
  conversationId: string;
  organizationId: string;
  employeeId: string;
  contactId: string;
  claimContact: boolean;
}): Promise<AttributionResult> {
  const pool = getPool();

  const { rowCount } = await pool.query(
    `update conversations
        set referred_by_employee_id = $2,
            referred_at = now(),
            -- Only fills an EMPTY assignment. A conversation a human has
            -- already picked up must not be pulled back by a tag.
            employee_id = coalesce(employee_id, $2)
      where id = $1
        and referred_by_employee_id is null`,
    [input.conversationId, input.employeeId]
  );
  const recorded = (rowCount ?? 0) > 0;

  if (!input.claimContact) return { recorded, claimed: false, conflictWith: null };

  // Claim only what nobody owns. `where owner_employee_id is null` is the whole
  // safety property: a link can bring a staff member a NEW client and can never
  // take one from a colleague.
  const claim = await pool.query(
    `update contacts ct
        set owner_employee_id = $2,
            captured_by_employee_id = coalesce(ct.captured_by_employee_id, $2),
            captured_at = coalesce(ct.captured_at, now()),
            updated_at = now()
      where ct.id = $3
        and ${contactServedBy("$1")}
        and ct.owner_employee_id is null`,
    [input.organizationId, input.employeeId, input.contactId]
  );
  if ((claim.rowCount ?? 0) > 0) return { recorded, claimed: true, conflictWith: null };

  // Not claimed. Either somebody else has them, or they are not this business's
  // to claim. Only the first is worth reporting, and it is reported by NAME
  // because within one business "Rinal already has them" is the useful answer.
  // The owner's id, read WITHOUT joining employees -- see below.
  const owner = await pool.query<{ owner_employee_id: string | null }>(
    `select ct.owner_employee_id
       from contacts ct
      where ct.id = $3
        and ${contactServedBy("$1")}
        and not ${contactOwnedBy("$2")}`,
    [input.organizationId, input.employeeId, input.contactId]
  );
  const otherOwner = owner.rows[0]?.owner_employee_id ?? null;
  if (!otherOwner) return { recorded, claimed: false, conflictWith: null };

  // Two queries rather than one join, for the same reason findEmployeeByCode is
  // wrapped: the write above must happen in the NUMBER OWNER's scope, because
  // the contact row belongs to the owner and the policy's WITH CHECK compares
  // organization_id to app.current_org. The employee NAME must be read in the
  // SERVING business's scope, because that is the only scope employees are
  // visible in. One statement cannot be in two scopes, and a join would have
  // quietly returned no name and reported "nobody else owns them".
  const name = await withServingTenant(input.organizationId, async () => {
    const { rows } = await getPool().query<{ full_name: string }>(
      `select full_name from employees where id = $1`,
      [otherOwner]
    );
    return rows[0]?.full_name ?? null;
  });
  return { recorded, claimed: false, conflictWith: name };
}

/**
 * What one staff member's link has actually produced.
 *
 * The number a person wants when deciding whether the posting is worth doing.
 * Counts CONVERSATIONS rather than contacts: the same customer coming back
 * through the link twice is two pieces of work, and one client.
 */
export async function referralsForEmployee(
  employeeId: string
): Promise<{ conversations: number; clients: number; firstAt: string | null }> {
  const { rows } = await getPool().query<{
    conversations: string;
    clients: string;
    first_at: string | null;
  }>(
    `select count(c.id)                       as conversations,
            count(distinct c.contact_id)      as clients,
            min(c.referred_at)::text          as first_at
       from conversations c
      where c.referred_by_employee_id = $1`,
    [employeeId]
  );
  return {
    conversations: Number(rows[0]?.conversations ?? 0),
    clients: Number(rows[0]?.clients ?? 0),
    firstAt: rows[0]?.first_at ?? null,
  };
}
