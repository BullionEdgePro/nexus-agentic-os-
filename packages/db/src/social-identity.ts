import { getPool, withTenant } from "./client.js";
import type { ConversationChannel } from "@nexus/shared";

/**
 * Finding the person behind a Messenger PSID, an Instagram IGSID, an email.
 *
 * ============================================================
 * A CONTACT IDENTIFIED BY SOMETHING OTHER THAN A PHONE
 * ============================================================
 *
 * `recordInboundMessage` resolves a WhatsApp contact by `(organization_id,
 * wa_id)`. The channels that ride the same Meta plumbing but arrive as a
 * page-scoped id have no wa_id at all, so they cannot use that path — migration
 * 088 gave contacts a second identity, `(organization_id, channel, external_id)`,
 * and this resolves a contact against it.
 *
 * It is the WhatsApp upsert's twin, deliberately: same find-or-create shape, same
 * "never blank out a name already on file" rule, keyed on the external identity
 * instead of the phone. The conversation and the message are NOT its job — this
 * settles only WHO the person is; the caller (the inbound processor, next slice)
 * opens the conversation on the right channel and records the message on top.
 *
 * The `organization_id` is the business that owns the connected Page/account —
 * the caller resolves it from the delivery (a page id maps to one business) and
 * scopes the write to it, so a contact is created under the business that can
 * actually answer, never a global one.
 */

export interface FindOrCreateExternalContactInput {
  /** The business that owns the Page/account the message arrived on. */
  organizationId: string;
  /** The channel the external id belongs to (facebook, instagram, email, …). */
  channel: Extract<ConversationChannel, "facebook" | "instagram" | "email" | "sms">;
  /** The channel-scoped identity: a PSID, an IGSID, an email address. */
  externalId: string;
  /** A name to set if the contact is new or has none yet; never overwrites one. */
  displayName?: string | null;
}

export interface FindOrCreateExternalContactResult {
  contactId: string;
  /** True only when this call created the row, so the caller can greet once. */
  created: boolean;
}

/**
 * Resolve — creating if new — the contact for a non-WhatsApp external identity.
 *
 * Upserts on the `(organization_id, channel, external_id)` identity added in
 * migration 088. `wa_id` is left null: this person is known by their channel id,
 * not a phone, and the `contacts_has_identity` check is satisfied by external_id.
 * A name already on file is kept; a blank incoming name never erases it.
 */
export async function findOrCreateContactByExternalId(
  input: FindOrCreateExternalContactInput
): Promise<FindOrCreateExternalContactResult> {
  const externalId = input.externalId.trim();
  if (!externalId) {
    // A contact with no identity can never be reached again, and the check
    // constraint would reject the row anyway — fail loudly at the source.
    throw new Error("Cannot create a contact without an external id.");
  }

  return withTenant(input.organizationId, async () => {
    const db = getPool();
    const contact = await db.query<{ id: string; inserted: boolean }>(
      `insert into contacts (organization_id, channel, external_id, display_name, last_message_at)
       values ($1, $2, $3, $4, now())
       on conflict (organization_id, channel, external_id) where external_id is not null
       do update set
         display_name = coalesce(contacts.display_name, excluded.display_name),
         last_message_at = now(),
         updated_at = now()
       returning id, (xmax = 0) as inserted`,
      [input.organizationId, input.channel, externalId, input.displayName?.trim() || null]
    );
    return { contactId: contact.rows[0].id, created: contact.rows[0].inserted };
  });
}
