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

/**
 * The one conversation for a contact on a given channel, created if new.
 *
 * One per contact per channel, the same rule findOrCreateEmailConversation
 * follows: a person is a single relationship in the inbox, and their Messenger
 * thread is one conversation however many separate messages arrive. Runs inside
 * the caller's tenant context (the processor's withTenant), so RLS scopes it.
 */
export async function findOrCreateSocialConversation(
  organizationId: string,
  contactId: string,
  channel: Extract<ConversationChannel, "facebook" | "instagram">
): Promise<string> {
  const db = getPool();
  const existing = await db.query<{ id: string }>(
    `select id from conversations
      where organization_id = $1 and contact_id = $2 and channel = $3
        and status in ('open', 'pending')
      order by opened_at desc
      limit 1`,
    [organizationId, contactId, channel]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await db.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel, status)
     values ($1, $2, $3, 'open')
     returning id`,
    [organizationId, contactId, channel]
  );
  return inserted.rows[0].id;
}

export interface InboundSocialMessageInput {
  organizationId: string;
  conversationId: string;
  contactId: string;
  body: string;
  /** Meta's message id (the mid) — the dedup key, unique per message. */
  socialMessageId: string;
  /** Milliseconds since epoch from Meta's timestamp, or null to use now(). */
  receivedAtMs: number | null;
}

/**
 * Store one inbound Messenger/Instagram message, or do nothing if already stored.
 *
 * Dedup is the whole point, exactly as on the email channel: Meta redelivers, and
 * the mid (unique via idx_messages_social_message_id) is what stops a message
 * being appended twice. Returns the new message id ONLY when a row was actually
 * inserted, so the caller publishes an inbox event once and never on a redelivery.
 */
export async function insertInboundSocialMessage(
  input: InboundSocialMessageInput
): Promise<{ messageId: string | null }> {
  const receivedAt = input.receivedAtMs && input.receivedAtMs > 0 ? new Date(input.receivedAtMs) : null;
  const { rows } = await getPool().query<{ id: string }>(
    `insert into messages
       (organization_id, conversation_id, contact_id, direction, sender_type,
        message_type, body, status, social_message_id, created_at)
     values ($1, $2, $3, 'inbound', 'contact', 'text', $4, 'delivered', $5, coalesce($6::timestamptz, now()))
     on conflict (social_message_id) where social_message_id is not null do nothing
     returning id`,
    [
      input.organizationId,
      input.conversationId,
      input.contactId,
      input.body,
      input.socialMessageId,
      receivedAt,
    ]
  );
  return { messageId: rows[0]?.id ?? null };
}
