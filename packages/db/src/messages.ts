import { getPool, withTenant } from "./client.js";
import type {
  AttachmentKind,
  MessageAttachment,
  MessageDirection,
  MessageDto,
  MessageStatus,
  SenderType,
} from "@nexus/shared";
import { DELIVERY_STATUS_LADDER } from "@nexus/shared";

export interface RecordInboundMessageInput {
  organizationId: string;
  contactWaId: string;
  contactName?: string;
  waMessageId: string;
  body: string;
  messageType?: string;
  rawPayload: unknown;
  /**
   * The staff member's own number this arrived on. A customer who writes to
   * two people at the same business has two threads, one per person — never
   * one merged chat that whoever answered last owns. A legacy thread with no
   * number (the old shared line) is picked up rather than orphaned.
   */
  onNumber?: string | null;
}

export interface RecordInboundMessageResult {
  conversationId: string;
  contactId: string;
  messageId: string | null; // null when this wa_message_id was already recorded (webhook retry)
  /** On a retry, the message already stored and when it arrived. Null on a first delivery. */
  replayOf: { messageId: string; recordedAt: string } | null;
  isHumanHandoff: boolean;
  aiPausedUntil: string | null;
}

/**
 * Upserts the contact, ensures an open conversation exists, and records the
 * inbound message. Runs inside a single transaction so a webhook retry never
 * produces duplicate contacts or conversations. Also returns the current
 * handoff state so the caller can decide whether the AI agent is allowed to
 * respond.
 */
export async function recordInboundMessage(
  input: RecordInboundMessageInput
): Promise<RecordInboundMessageResult> {
  // The transaction is withTenant's now: it checks out one connection, opens
  // the transaction, sets app.current_org on it, and commits or rolls back
  // around this whole block. Every getPool().query below lands on that same
  // connection, so the atomicity this function always had is unchanged — it is
  // now also scoped to the business the message belongs to.
  return withTenant(input.organizationId, async () => {
    const db = getPool();

    const contactResult = await db.query<{ id: string; ai_paused_until: string | null }>(
      `insert into contacts (organization_id, wa_id, display_name, last_message_at)
       values ($1, $2, $3, now())
       on conflict (organization_id, wa_id)
       do update set display_name = coalesce(excluded.display_name, contacts.display_name),
                     last_message_at = now()
       returning id, ai_paused_until`,
      [input.organizationId, input.contactWaId, input.contactName ?? null]
    );
    const contactId = contactResult.rows[0].id;
    const aiPausedUntil = contactResult.rows[0].ai_paused_until;

    const conversationResult = await db.query<{ id: string; is_human_handoff: boolean }>(
      `select id, is_human_handoff from conversations
       where organization_id = $1 and contact_id = $2 and status in ('open', 'pending', 'resolved')
         and ($3::text is null or phone_number_id = $3 or phone_number_id is null)
       order by (phone_number_id is not distinct from $3) desc, opened_at desc limit 1`,
      [input.organizationId, contactId, input.onNumber ?? null]
    );

    let conversationId: string;
    let isHumanHandoff: boolean;
    if (conversationResult.rows[0]) {
      conversationId = conversationResult.rows[0].id;
      isHumanHandoff = conversationResult.rows[0].is_human_handoff;
    } else {
      const inserted = await db.query<{ id: string; is_human_handoff: boolean }>(
        `insert into conversations (organization_id, contact_id, phone_number_id) values ($1, $2, $3)
         returning id, is_human_handoff`,
        [input.organizationId, contactId, input.onNumber ?? null]
      );
      conversationId = inserted.rows[0].id;
      isHumanHandoff = inserted.rows[0].is_human_handoff;
    }

    const messageResult = await db.query<{ id: string }>(
      `insert into messages
         (organization_id, conversation_id, contact_id, wa_message_id, direction, sender_type, message_type, body, raw_payload, status)
       values ($1, $2, $3, $4, 'inbound', 'contact', $5, $6, $7, 'delivered')
       on conflict (wa_message_id) where wa_message_id is not null do nothing
       returning id`,
      [
        input.organizationId,
        conversationId,
        contactId,
        input.waMessageId,
        input.messageType ?? "text",
        input.body,
        JSON.stringify(input.rawPayload),
      ]
    );

    // WHICH MESSAGE THE REPLAY IS OF, and when it first arrived.
    //
    // `do nothing` returns no row, so on a conflict the caller used to learn
    // only that this had been seen before. That was enough while "seen before"
    // and "already answered" were the same thing, and they are not: if the
    // worker died between this insert and the reply going out, the retry finds
    // the row, concludes replay, and the customer is never answered at all.
    //
    // Read only on the replay path, which is rare, so the happy path pays
    // nothing for it.
    let replayOf: { messageId: string; recordedAt: string } | null = null;
    if (!messageResult.rows[0]) {
      const existing = await db.query<{ id: string; created_at: string }>(
        `select id, created_at from messages where wa_message_id = $1 limit 1`,
        [input.waMessageId]
      );
      if (existing.rows[0]) {
        replayOf = { messageId: existing.rows[0].id, recordedAt: existing.rows[0].created_at };
      }
    }

    return {
      conversationId,
      contactId,
      messageId: messageResult.rows[0]?.id ?? null,
      replayOf,
      isHumanHandoff,
      aiPausedUntil,
    };
  });
}

export interface InsertOutboundMessageInput {
  organizationId: string;
  conversationId: string;
  contactId: string;
  senderType: Extract<SenderType, "ai_agent" | "human_agent" | "system">;
  senderId?: string;
  body: string;
  waMessageId?: string;
  /** Meta's Messenger/Instagram message id (the mid), for a reply sent on those channels. */
  socialMessageId?: string;
  /** Gmail id of an email reply. Its presence makes this an 'email' message, and
   *  it is the dedup key the sync uses to skip this very send when it sees it. */
  emailMessageId?: string;
  /** The Gmail thread an email reply went out on. */
  emailThreadId?: string;
  /** Employee this reply is attributed to (their twin authored it). */
  employeeId?: string | null;
}

export async function insertOutboundMessage(input: InsertOutboundMessageInput): Promise<MessageDto> {
  const { rows } = await getPool().query<{
    id: string;
    conversation_id: string;
    direction: MessageDirection;
    sender_type: SenderType;
    body: string | null;
    status: string;
    created_at: string;
  }>(
    // 'queued' where Meta gave us a receipt to follow, 'sent' where it did not.
    //
    // This row used to be written with the literal 'sent' always, which read as
    // a measurement and was a hardcoded claim: nothing ever moved it, and on
    // 2026-08-17 all 24 outbound rows in production said 'sent' with no
    // `wa_message_id` to check it against. A 200 from the Graph API means Meta
    // ACCEPTED the message; whether anybody received it arrives later, on the
    // status webhook, keyed by the wamid.
    //
    // So with a wamid the honest state is 'queued' — accepted, not yet
    // confirmed — and `recordDeliveryStatus` moves it. Without one there will
    // never be a receipt, and parking it at 'queued' forever would have the
    // operator report a permanent backlog of messages that were fine.
    // social_message_id carries Meta's mid for a Messenger/Instagram reply. It
    // does NOT drive the status: those channels have no delivery-receipt webhook
    // wired here, so a social reply parks at 'sent' (accepted), exactly as a
    // WhatsApp send with no wamid does — only a wa_message_id means "await a
    // receipt", so the status CASE stays keyed on it alone.
    //
    // An email reply (email_message_id present) is its own shape: message_type
    // 'email' so it reads with the synced thread rather than as a text bubble,
    // and status 'delivered' because a 200 from Gmail IS delivery — there is no
    // later receipt to wait on, unlike a wamid. The email id also stores as the
    // dedup key so the inbound sweep skips this send when it sees it in the box.
    `insert into messages
       (organization_id, conversation_id, contact_id, wa_message_id, social_message_id, direction, sender_type, sender_id, message_type, body, status, employee_id, email_message_id, email_thread_id)
     values ($1, $2, $3, $4, $9, 'outbound', $5, $6,
             case when $10::text is not null then 'email' else 'text' end, $7,
             case when $4::text is not null then 'queued'
                  when $10::text is not null then 'delivered'
                  else 'sent' end,
             $8, $10, $11)
     returning id, conversation_id, direction, sender_type, body, status, created_at`,
    [
      input.organizationId,
      input.conversationId,
      input.contactId,
      input.waMessageId ?? null,
      input.senderType,
      input.senderId ?? null,
      input.body,
      input.employeeId ?? null,
      input.socialMessageId ?? null,
      input.emailMessageId ?? null,
      input.emailThreadId ?? null,
    ]
  );
  const row = rows[0];
  return {
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    senderType: row.sender_type,
    body: row.body,
    status: row.status as MessageDto["status"],
    createdAt: row.created_at,
  };
}

export interface ImportHistoryThreadInput {
  organizationId: string;
  /** The customer this thread is with. */
  contactWaId: string;
  /** Their name from the staff member's phone book, when it was shared. */
  contactName?: string | null;
  /** The staff member's own number the history came from. */
  onNumber: string;
  employeeId: string;
  messages: Array<{
    waMessageId: string;
    direction: "inbound" | "outbound";
    messageType: string;
    body: string;
    /** When it was actually sent, on the phone. */
    at: string;
    status: "sent" | "delivered" | "read" | "failed";
    rawPayload: unknown;
  }>;
}

/**
 * Write one thread of a staff member's past chats, imported from their
 * WhatsApp Business app when they connected it (Coexistence history sync,
 * 28 Oct 2026).
 *
 * HISTORY, NOT TRAFFIC. Each message keeps the time it was really sent, is
 * deduped on its wamid like every other writer here (Meta resends chunks), and
 * nothing is published or answered: the agent never sees these. A thread that
 * has no conversation yet gets one filed as resolved, opened at its first
 * message, so a few hundred old chats do not land in anybody's open queue — a
 * new message from that customer reopens it the ordinary way. The contact's
 * name is filled only where none is known; a name already typed in Nexus wins.
 */
export async function importHistoryThread(
  input: ImportHistoryThreadInput
): Promise<{ conversationId: string; contactId: string; created: boolean; inserted: number }> {
  const times = input.messages.map((message) => message.at).sort();
  const first = times[0] ?? new Date().toISOString();
  const last = times[times.length - 1] ?? first;
  return withTenant(input.organizationId, async () => {
    const db = getPool();
    const contact = await db.query<{ id: string }>(
      `insert into contacts (organization_id, wa_id, display_name, last_message_at)
       values ($1, $2, $3, $4)
       on conflict (organization_id, wa_id)
       do update set display_name = coalesce(contacts.display_name, excluded.display_name),
                     last_message_at = greatest(contacts.last_message_at, excluded.last_message_at)
       returning id`,
      [input.organizationId, input.contactWaId, input.contactName?.trim() || null, last]
    );
    const contactId = contact.rows[0].id;

    // The same find the inbound writer and the echo use, so history lands in
    // the conversation a new message from this customer would.
    const existing = await db.query<{ id: string }>(
      `select id from conversations
        where organization_id = $1 and contact_id = $2 and status in ('open', 'pending', 'resolved')
          and (phone_number_id = $3 or phone_number_id is null)
        order by (phone_number_id is not distinct from $3) desc, opened_at desc limit 1`,
      [input.organizationId, contactId, input.onNumber]
    );
    let conversationId = existing.rows[0]?.id;
    const created = !conversationId;
    if (!conversationId) {
      conversationId = (
        await db.query<{ id: string }>(
          `insert into conversations (organization_id, contact_id, phone_number_id, status, opened_at)
           values ($1, $2, $3, 'resolved', $4) returning id`,
          [input.organizationId, contactId, input.onNumber, first]
        )
      ).rows[0].id;
    }

    let inserted = 0;
    for (const message of input.messages) {
      const outbound = message.direction === "outbound";
      const result = await db.query(
        `insert into messages
           (organization_id, conversation_id, contact_id, wa_message_id, direction, sender_type,
            message_type, body, raw_payload, status, employee_id, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (wa_message_id) where wa_message_id is not null do nothing`,
        [
          input.organizationId,
          conversationId,
          contactId,
          message.waMessageId,
          message.direction,
          outbound ? "human_agent" : "contact",
          message.messageType,
          message.body,
          JSON.stringify(message.rawPayload),
          message.status,
          outbound ? input.employeeId : null,
          message.at,
        ]
      );
      inserted += result.rowCount ?? 0;
    }
    return { conversationId, contactId, created, inserted };
  });
}

/**
 * Which of these contacts wrote to this number recently enough to be messaged
 * in free text (29 Oct 2026).
 *
 * WhatsApp lets a business send anything — no approved template — only inside
 * the 24 hours after the customer's last message to that number. The window is
 * read as 23h50m so a send that starts at the edge does not land outside it.
 * Keyed on the number, not the business: a customer who wrote to the shared
 * line has opened no window on a staff member's own number. Imported history
 * keeps its original times, so it never opens a window.
 */
export async function openWindowConversations(
  organizationId: string,
  phoneNumberId: string,
  contactIds: string[]
): Promise<Array<{ contactId: string; conversationId: string; lastInboundAt: string }>> {
  if (contactIds.length === 0) return [];
  return withTenant(organizationId, async () => {
    const { rows } = await getPool().query<{ contact_id: string; conversation_id: string; last_inbound_at: string }>(
      `select distinct on (m.contact_id) m.contact_id, m.conversation_id, m.created_at as last_inbound_at
         from messages m
         join conversations c on c.id = m.conversation_id
        where c.organization_id = $1
          and c.phone_number_id = $2
          and m.direction = 'inbound'
          and m.created_at > now() - interval '23 hours 50 minutes'
          and m.contact_id = any($3::uuid[])
        order by m.contact_id, m.created_at desc`,
      [organizationId, phoneNumberId, contactIds]
    );
    return rows.map((row) => ({
      contactId: row.contact_id,
      conversationId: row.conversation_id,
      lastInboundAt: row.last_inbound_at,
    }));
  });
}

/**
 * A name from the staff member's phone book, for a contact Nexus knows by
 * number only. Never overwrites a name already held.
 */
export async function nameContactIfUnnamed(organizationId: string, waId: string, name: string): Promise<void> {
  await withTenant(organizationId, () =>
    getPool().query(
      `update contacts set display_name = $3
        where organization_id = $1 and wa_id = $2 and (display_name is null or display_name = '')`,
      [organizationId, waId, name.trim()]
    )
  );
}

export interface RecordOutboundEchoInput {
  organizationId: string;
  /** The customer the staff member messaged (the echo's `to`). */
  contactWaId: string;
  body: string;
  /** Meta's id for the message, used to ignore a redelivered echo. */
  waMessageId: string;
  /** The staff member who sent it from their own WhatsApp Business app. */
  employeeId: string;
  /** Their number — keys the thread the same way recordInboundMessage does. */
  onNumber?: string | null;
}

/**
 * Record a message a staff member sent to a customer FROM their phone.
 *
 * Coexistence mirrors those sends to us as `smb_message_echoes`. This finds (or
 * opens) the same conversation an inbound from that customer would land in and
 * writes the message as an ordinary outbound `human_agent` reply — so the
 * dashboard shows exactly what the customer sees, whichever device it was typed
 * on.
 *
 * DEDUPED ON THE wamid like recordInboundMessage: Meta redelivers, and a `message`
 * is returned only when a row was actually written, so the caller can publish a
 * live update once and never twice. Mirrors the inbound writer's find-or-create
 * so the two can never disagree about which conversation a customer is in.
 */
export async function recordOutboundEcho(
  input: RecordOutboundEchoInput
): Promise<{ conversationId: string; contactId: string; message: MessageDto | null }> {
  return withTenant(input.organizationId, async () => {
    const db = getPool();

    const contact = await db.query<{ id: string }>(
      `insert into contacts (organization_id, wa_id, last_message_at)
       values ($1, $2, now())
       on conflict (organization_id, wa_id)
       do update set last_message_at = now()
       returning id`,
      [input.organizationId, input.contactWaId]
    );
    const contactId = contact.rows[0].id;

    const existing = await db.query<{ id: string }>(
      `select id from conversations
        where organization_id = $1 and contact_id = $2 and status in ('open', 'pending', 'resolved')
          and ($3::text is null or phone_number_id = $3 or phone_number_id is null)
        order by (phone_number_id is not distinct from $3) desc, opened_at desc limit 1`,
      [input.organizationId, contactId, input.onNumber ?? null]
    );
    const conversationId =
      existing.rows[0]?.id ??
      (
        await db.query<{ id: string }>(
          `insert into conversations (organization_id, contact_id, phone_number_id) values ($1, $2, $3) returning id`,
          [input.organizationId, contactId, input.onNumber ?? null]
        )
      ).rows[0].id;

    const inserted = await db.query<{
      id: string;
      conversation_id: string;
      direction: MessageDirection;
      sender_type: SenderType;
      body: string | null;
      status: string;
      created_at: string;
    }>(
      // 'delivered' rather than 'queued': an echo is a message that HAS been sent
      // and received, not one we are asking Meta to send — there is no receipt to
      // wait on. Deduped on the wamid, so a redelivered echo returns no row.
      `insert into messages
         (organization_id, conversation_id, contact_id, wa_message_id, direction, sender_type, message_type, body, status, employee_id)
       values ($1, $2, $3, $4, 'outbound', 'human_agent', 'text', $5, 'delivered', $6)
       on conflict (wa_message_id) where wa_message_id is not null do nothing
       returning id, conversation_id, direction, sender_type, body, status, created_at`,
      [input.organizationId, conversationId, contactId, input.waMessageId, input.body, input.employeeId]
    );

    const row = inserted.rows[0];
    return {
      conversationId,
      contactId,
      message: row
        ? {
            id: row.id,
            conversationId: row.conversation_id,
            direction: row.direction,
            senderType: row.sender_type,
            body: row.body,
            status: row.status as MessageDto["status"],
            createdAt: row.created_at,
          }
        : null,
    };
  });
}

export async function getMessagesForConversation(
  conversationId: string,
  limit = 50
): Promise<MessageDto[]> {
  // THE LATEST `limit`, shown oldest-first. This was `order by created_at asc
  // limit N` — the OLDEST N — so a thread past fifty messages stopped showing
  // anything new, and AI "Suggest reply" drafted from the start of the chat
  // instead of its end.
  const { rows } = await getPool().query<{
    id: string;
    conversation_id: string;
    direction: MessageDirection;
    sender_type: SenderType;
    body: string | null;
    status: string;
    created_at: string;
    sender_name: string | null;
    message_type: string | null;
    filename: string | null;
  }>(
    `select * from (
       select m.id, m.conversation_id, m.direction, m.sender_type, m.body, m.status, m.created_at,
              m.message_type, m.raw_payload->'document'->>'filename' as filename,
              case when m.sender_type = 'human_agent'
                   then coalesce(e.full_name, a.full_name) end as sender_name
         from messages m
         left join employees e on m.sender_type = 'human_agent' and e.id::text = m.sender_id
         left join admins a on m.sender_type = 'human_agent' and a.id::text = m.sender_id
        where m.conversation_id = $1
        order by m.created_at desc
        , case when m.direction = 'outbound' then 0 else 1 end
        limit $2
     ) latest
     order by created_at asc
     , case when direction = 'inbound' then 0 else 1 end`,
    [conversationId, limit]
  );
  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    direction: row.direction,
    senderType: row.sender_type,
    body: row.body,
    status: row.status as MessageDto["status"],
    createdAt: row.created_at,
    senderName: row.sender_name,
    attachment: attachmentOf(row.message_type, row.filename),
  }));
}

const ATTACHMENT_KINDS = new Set<AttachmentKind>(["image", "video", "audio", "document", "sticker"]);

function attachmentOf(messageType: string | null, filename: string | null): MessageAttachment | null {
  if (!messageType || !ATTACHMENT_KINDS.has(messageType as AttachmentKind)) return null;
  return { kind: messageType as AttachmentKind, filename: messageType === "document" ? filename : null };
}

/**
 * Where to fetch the file a customer sent: Meta's media id, and the number it
 * arrived on (whose token may download it). Scoped to the conversation, so a
 * message id from another chat returns nothing. Null for anything that is not
 * an inbound attachment.
 */
export async function getInboundMediaRef(
  conversationId: string,
  messageId: string
): Promise<{ mediaId: string; mimeType: string | null; filename: string | null; phoneNumberId: string } | null> {
  const { rows } = await getPool().query<{
    message_type: string;
    media: { id?: string; mime_type?: string; filename?: string } | null;
    phone_number_id: string | null;
  }>(
    `select m.message_type,
            m.raw_payload -> m.message_type as media,
            coalesce(c.phone_number_id, o.whatsapp_phone_number_id) as phone_number_id
       from messages m
       join conversations c on c.id = m.conversation_id
       join organizations o on o.id = c.organization_id
      where m.id = $2 and m.conversation_id = $1 and m.direction = 'inbound'`,
    [conversationId, messageId]
  );
  const r = rows[0];
  if (!r || !ATTACHMENT_KINDS.has(r.message_type as AttachmentKind)) return null;
  const mediaId = r.media?.id;
  if (!mediaId || !r.phone_number_id) return null;
  return {
    mediaId,
    mimeType: r.media?.mime_type ?? null,
    filename: r.media?.filename ?? null,
    phoneNumberId: r.phone_number_id,
  };
}

/**
 * A delivery receipt from Meta, applied to the message it refers to.
 *
 * The status webhook is the other half of `sendWhatsAppText` returning a wamid.
 * It carries that id, a status, and a timestamp — and nothing else that says
 * which message it is about, which is why migration 048 indexes
 * `wa_message_id`.
 *
 * OUT-OF-ORDER DELIVERY IS THE NORMAL CASE, not the edge one. `sent`,
 * `delivered` and `read` arrive as separate webhook deliveries and each can be
 * retried, so a late `sent` landing after `read` is ordinary. Applied blindly it
 * walks the message backwards, and the visible consequence is an operator
 * reporting a message as stuck that the customer read an hour ago.
 *
 * So the guard lives in the WHERE clause rather than in a read-then-write, which
 * would race two webhooks against each other. Two rules:
 *
 *   - `failed` always applies, unless the row already failed. It is terminal and
 *     can arrive from any rung.
 *   - anything else applies only if it is further along the ladder than what is
 *     recorded, and only if the row has not failed.
 *
 * The ladder is passed in from `@nexus/shared` rather than written here, so
 * there is exactly one definition of the order rather than one in TypeScript and
 * one in SQL that agree right up until somebody edits either.
 *
 * Returns whether anything moved. False is a completely normal answer — a
 * duplicate webhook, a stale status, or a wamid belonging to a message this
 * platform did not send — and the caller must not treat it as an error.
 */
export async function recordDeliveryStatus(input: {
  waMessageId: string;
  status: MessageStatus;
  errorText?: string | null;
}): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update messages
        set status = $2,
            -- Preserved rather than overwritten with null: the error is the
            -- most useful thing on a failed row, and a later status carrying no
            -- error text must not erase why it failed.
            delivery_error = coalesce($3, delivery_error),
            delivery_updated_at = now()
      where wa_message_id = $1
        and direction = 'outbound'
        and (
              ($2 = 'failed' and status <> 'failed')
              or (
                status <> 'failed'
                and coalesce(array_position($4::text[], $2), 0)
                  > coalesce(array_position($4::text[], status), 0)
              )
            )`,
    [input.waMessageId, input.status, input.errorText ?? null, [...DELIVERY_STATUS_LADDER]]
  );
  return (rowCount ?? 0) > 0;
}
