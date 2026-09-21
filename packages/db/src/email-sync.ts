import { getPool, withAllTenants } from "./client.js";
import { contactServedBy } from "./contacts.js";
import { contactOwnedBy } from "./client-book.js";

/**
 * The database side of the email channel's INBOUND sync.
 *
 * A staff member's email with a client is pulled into a conversation on channel
 * 'email', so it reads in the same inbox as their WhatsApp threads. Everything
 * here runs inside the caller's tenant context (withTenant), so RLS scopes every
 * read and write to the one business without it being named again.
 *
 * The identity rule (decided with the owner): the email channel covers contacts
 * who ALREADY EXIST and have an email on file — a customer who wrote in on
 * WhatsApp and whose address a colleague recorded. Email-only people, who never
 * had a WhatsApp id, are a later step; the contacts table still requires a wa_id.
 */

export interface EmailClientContact {
  contactId: string;
  email: string;
}

/**
 * A staff member's own clients that have an email on file — the addresses whose
 * mail may be read into a conversation, and the contact each one belongs to.
 * Same scoping as clientEmailAddresses; this one also returns the contact id so
 * a fetched message can be filed against the right person.
 */
export async function clientContactsWithEmail(
  organizationId: string,
  employeeId: string
): Promise<EmailClientContact[]> {
  const { rows } = await getPool().query<{ contact_id: string; email: string }>(
    `select ct.id as contact_id, lower(ct.attributes->>'email') as email
       from contacts ct
      where ${contactServedBy("$1")}
        and ${contactOwnedBy("$2")}
        and ct.attributes->>'email' is not null
        and ct.attributes->>'email' <> ''`,
    [organizationId, employeeId]
  );
  return rows.map((r) => ({ contactId: r.contact_id, email: r.email }));
}

/**
 * Everything an outbound email reply needs, resolved from a conversation id.
 *
 * A reply to an email thread has to leave from the RIGHT mailbox — the staff
 * member who owns the client, sending as themselves — to the RIGHT address, and
 * thread onto the conversation it answers rather than starting a new one. That
 * is four facts spread across three tables:
 *
 *   - the owning employee (whose Gmail token sends it), from the contact;
 *   - the client's email address (the recipient), from the contact attributes;
 *   - the Gmail thread to continue and the most recent message in it to reply to,
 *     from the messages already synced into this conversation.
 *
 * CROSS-TENANT, and named so, for the same reason `findConversationById` is: a
 * conversation id is globally unique and the caller has only the id, so this
 * resolves the tenant rather than running inside one. The reply route enforces
 * access before it ever calls here.
 *
 * The message fields are null on a conversation that is on the email channel but
 * has no synced mail yet — the reply then goes out as a fresh thread, which the
 * caller handles. `toEmail`/`ownerEmployeeId` null means the reply cannot be
 * sent at all (no address on file, or a contact owned by nobody), and the caller
 * refuses with an honest reason rather than sending into the void.
 */
export interface EmailReplyContext {
  organizationId: string;
  ownerEmployeeId: string | null;
  toEmail: string | null;
  /** The Gmail thread to continue; null when nothing is synced yet. */
  threadId: string | null;
  /** The most recent synced message's Gmail id, to reply to for threading. */
  replyToGmailMessageId: string | null;
}

export async function emailReplyContext(conversationId: string): Promise<EmailReplyContext | null> {
  return withAllTenants(
    "resolve an email conversation to the mailbox and thread a reply must use — the caller has only the id",
    async () => {
      const { rows } = await getPool().query<{
        organization_id: string;
        owner_employee_id: string | null;
        to_email: string | null;
        email_thread_id: string | null;
        email_message_id: string | null;
      }>(
        // The latest synced email in this conversation (either direction) is the
        // one a reply threads onto — its thread id continues the thread, its
        // Gmail id is what the reply is In-Reply-To. A lateral limit-1 rather
        // than an aggregate so both columns come from the SAME message.
        `select c.organization_id,
                ct.owner_employee_id,
                lower(ct.attributes->>'email') as to_email,
                m.email_thread_id,
                m.email_message_id
           from conversations c
           join contacts ct on ct.id = c.contact_id
           left join lateral (
             select email_thread_id, email_message_id
               from messages
              where conversation_id = c.id and email_message_id is not null
              order by created_at desc
              limit 1
           ) m on true
          where c.id = $1`,
        [conversationId]
      );
      const row = rows[0];
      if (!row) return null;
      return {
        organizationId: row.organization_id,
        ownerEmployeeId: row.owner_employee_id,
        toEmail: row.to_email && row.to_email.trim() ? row.to_email.trim() : null,
        threadId: row.email_thread_id,
        replyToGmailMessageId: row.email_message_id,
      };
    }
  );
}

/**
 * The one email conversation for a contact, created if it does not exist yet.
 *
 * One per contact rather than one per Gmail thread: a person is a single
 * relationship in the inbox, and splitting their mail across a conversation per
 * subject line would fragment exactly the history the channel exists to gather.
 */
export async function findOrCreateEmailConversation(
  organizationId: string,
  contactId: string
): Promise<string> {
  const existing = await getPool().query<{ id: string }>(
    `select id from conversations
      where organization_id = $1 and contact_id = $2 and channel = 'email'
      limit 1`,
    [organizationId, contactId]
  );
  if (existing.rows[0]) return existing.rows[0].id;

  const inserted = await getPool().query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel, status)
     values ($1, $2, 'email', 'open')
     returning id`,
    [organizationId, contactId]
  );
  return inserted.rows[0].id;
}

export interface SyncedEmail {
  organizationId: string;
  conversationId: string;
  contactId: string;
  direction: "inbound" | "outbound";
  body: string;
  emailMessageId: string;
  emailThreadId: string | null;
  receivedAt: string | null;
}

/**
 * Store one synced email as a message, or do nothing if it is already stored.
 *
 * Dedup is the whole point: the sync runs again and again, and the Gmail message
 * id (unique per mailbox) is what stops a message being appended twice. Returns
 * true only when a row was actually inserted, so the caller can count what is new.
 *
 * sender_type follows direction — an inbound email is from the 'contact', an
 * outbound one from the 'human_agent' who sent it — matching how a WhatsApp
 * message records who spoke.
 */
export async function insertSyncedEmailMessage(email: SyncedEmail): Promise<boolean> {
  const senderType = email.direction === "inbound" ? "contact" : "human_agent";
  const { rowCount } = await getPool().query(
    `insert into messages
       (organization_id, conversation_id, contact_id, direction, sender_type,
        message_type, body, status, email_message_id, email_thread_id, created_at)
     values ($1, $2, $3, $4, $5, 'email', $6, 'delivered', $7, $8, coalesce($9::timestamptz, now()))
     on conflict (email_message_id) where email_message_id is not null do nothing`,
    [
      email.organizationId,
      email.conversationId,
      email.contactId,
      email.direction,
      senderType,
      email.body,
      email.emailMessageId,
      email.emailThreadId,
      email.receivedAt,
    ]
  );
  return (rowCount ?? 0) > 0;
}
