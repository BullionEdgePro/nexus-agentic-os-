import { getPool, withTenant } from "./client.js";
import { findOrganizationById, findOrganizationByPhoneNumberId } from "./organizations.js";

/**
 * Creating a customer by hand, on a number five businesses share.
 *
 * ============================================================
 * WHICH BUSINESS A PERSON BELONGS TO
 * ============================================================
 *
 * Nobody. A contact belongs to the NUMBER, and the number has one owner.
 *
 * `recordInboundMessage` writes every contact under the organization resolved
 * from the WhatsApp phone number id — which `findOrganizationByPhoneNumberId`
 * orders `is_number_owner desc`, so it is always the owner. Measured on
 * production 2026-08-26: all 17 contacts carry Zipicka's organization_id,
 * including the ones who were talking to a law firm.
 *
 * So a hand-entered contact written under the SERVING business is a second
 * identity for the same person. The row looks right, the customer appears on
 * the right screen, and the moment they actually message the shared number the
 * webhook upserts on (owner, wa_id), finds nothing, and creates another. Two
 * contacts, one human, and the appointment is attached to the one nobody is
 * ever going to message.
 *
 * `captureEmployeeLead` does exactly this today. Its comment says the opposite
 * — "if this person later messages the shared number the webhook finds THIS row
 * instead of creating a second one" — and that was true when one business had
 * one number. It has never fired: zero contacts on production carry
 * `captured_by_employee_id`. It would have, the first time an employee of a law
 * firm typed in a name.
 *
 * ============================================================
 * THEN HOW DOES THE SERVING BUSINESS SEE THEM
 * ============================================================
 *
 * Through a conversation, which is where `served_organization_ids` comes from.
 * Migration 055 maintains that array by trigger, out of
 * `coalesce(routed_organization_id, organization_id)` over the contact's
 * conversations — so it cannot be set directly and stay set; the next trigger
 * run recomputes it from conversations and discards anything written by hand.
 *
 * The conversation is therefore not a workaround, it IS the mechanism: a
 * contact with a conversation routed to SFS is exactly the state a real
 * customer reaches after messaging once and being routed there.
 *
 * AN EMPTY CONVERSATION RAISES NOTHING. `customer-waiting` reads the last
 * message through a `join lateral (... from messages ... limit 1)`, which is an
 * inner join — a conversation with no messages produces no row and is dropped
 * before any of the operator's own conditions are reached. Checked rather than
 * assumed, because a false "a customer has been waiting" on the one console
 * built to be trusted would be worse than not having this feature.
 */
export interface EnsureContactInput {
  /** The business the customer is a customer OF. Not where the row lands. */
  servingOrganizationId: string;
  /** Digits only, international form, no plus — the same shape the webhook stores. */
  waId: string;
  displayName?: string | null;
  capturedByEmployeeId?: string | null;
}

export interface EnsuredContact {
  contactId: string;
  conversationId: string;
  /** False when this person was already known — by any business on the number. */
  created: boolean;
  /** The organization the row actually belongs to, for callers that report it. */
  ownerOrganizationId: string;
}

export async function ensureContactForServingBusiness(
  input: EnsureContactInput
): Promise<EnsuredContact> {
  const serving = await findOrganizationById(input.servingOrganizationId);
  if (!serving) throw new Error("That business does not exist.");

  const waId = input.waId.replace(/\D/g, "");
  if (waId.length < 8) {
    // Said as a sentence because it reaches a form. A too-short number is
    // almost always a local one typed without its country code, and that
    // produces a contact who can never be messaged.
    throw new Error(
      "That does not look like a WhatsApp number. Use the full international form, " +
        "digits only — for example 971501234567."
    );
  }

  // The owner of the number this business answers on. Falls back to the
  // business itself when it has no number configured at all, which is the
  // single-tenant case and the only one where they are the same organization.
  const owner = serving.whatsappPhoneNumberId
    ? (await findOrganizationByPhoneNumberId(serving.whatsappPhoneNumberId)) ?? serving
    : serving;

  return withTenant(owner.id, async () => {
    const db = getPool();

    // Keyed exactly as the webhook keys it, so an inbound message from this
    // person lands on this row rather than beside it.
    const contact = await db.query<{ id: string; inserted: boolean }>(
      `insert into contacts (organization_id, wa_id, display_name, captured_by_employee_id, captured_at)
       values ($1, $2, $3, $4, now())
       on conflict (organization_id, wa_id) do update set
         -- Never overwrite a name already on file with a blank one, and never
         -- re-attribute somebody already known: whoever found them keeps it.
         display_name = coalesce(contacts.display_name, excluded.display_name),
         captured_by_employee_id = coalesce(contacts.captured_by_employee_id, excluded.captured_by_employee_id),
         captured_at = coalesce(contacts.captured_at, excluded.captured_at),
         updated_at = now()
       returning id, (xmax = 0) as inserted`,
      [owner.id, waId, input.displayName?.trim() || null, input.capturedByEmployeeId ?? null]
    );
    const contactId = contact.rows[0].id;

    // An open conversation ROUTED to the serving business. Reused if one is
    // already open for them, so entering the same person twice does not leave a
    // trail of empty threads.
    const existing = await db.query<{ id: string }>(
      `select id from conversations
        where organization_id = $1
          and contact_id = $2
          and coalesce(routed_organization_id, organization_id) = $3
          and status in ('open', 'pending')
        order by opened_at desc
        limit 1`,
      [owner.id, contactId, serving.id]
    );

    if (existing.rows[0]) {
      return {
        contactId,
        conversationId: existing.rows[0].id,
        created: contact.rows[0].inserted,
        ownerOrganizationId: owner.id,
      };
    }

    // `routed_organization_id` is left NULL when the serving business IS the
    // owner. The trigger coalesces the two, so both spellings give the same
    // array — but a routed_organization_id pointing at the owner would read, to
    // anyone looking at the row, as a conversation that had been through triage.
    const opened = await db.query<{ id: string }>(
      `insert into conversations (organization_id, contact_id, routed_organization_id)
       values ($1, $2, $3)
       returning id`,
      [owner.id, contactId, serving.id === owner.id ? null : serving.id]
    );

    return {
      contactId,
      conversationId: opened.rows[0].id,
      created: contact.rows[0].inserted,
      ownerOrganizationId: owner.id,
    };
  });
}
