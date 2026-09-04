import { getPool, withTenant } from "./client.js";
import type { MessageDirection, MessageDto, MessageStatus, SenderType } from "@nexus/shared";
import { DELIVERY_STATUS_LADDER } from "@nexus/shared";

export interface RecordInboundMessageInput {
  organizationId: string;
  contactWaId: string;
  contactName?: string;
  waMessageId: string;
  body: string;
  messageType?: string;
  rawPayload: unknown;
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
       where organization_id = $1 and contact_id = $2 and status in ('open', 'pending')
       order by opened_at desc limit 1`,
      [input.organizationId, contactId]
    );

    let conversationId: string;
    let isHumanHandoff: boolean;
    if (conversationResult.rows[0]) {
      conversationId = conversationResult.rows[0].id;
      isHumanHandoff = conversationResult.rows[0].is_human_handoff;
    } else {
      const inserted = await db.query<{ id: string; is_human_handoff: boolean }>(
        `insert into conversations (organization_id, contact_id) values ($1, $2)
         returning id, is_human_handoff`,
        [input.organizationId, contactId]
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
    `insert into messages
       (organization_id, conversation_id, contact_id, wa_message_id, direction, sender_type, sender_id, message_type, body, status, employee_id)
     values ($1, $2, $3, $4, 'outbound', $5, $6, 'text', $7,
             case when $4::text is null then 'sent' else 'queued' end, $8)
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

export interface RecordOutboundEchoInput {
  organizationId: string;
  /** The customer the staff member messaged (the echo's `to`). */
  contactWaId: string;
  body: string;
  /** Meta's id for the message, used to ignore a redelivered echo. */
  waMessageId: string;
  /** The staff member who sent it from their own WhatsApp Business app. */
  employeeId: string;
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
        where organization_id = $1 and contact_id = $2 and status in ('open', 'pending')
        order by opened_at desc limit 1`,
      [input.organizationId, contactId]
    );
    const conversationId =
      existing.rows[0]?.id ??
      (
        await db.query<{ id: string }>(
          `insert into conversations (organization_id, contact_id) values ($1, $2) returning id`,
          [input.organizationId, contactId]
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
  const { rows } = await getPool().query<{
    id: string;
    conversation_id: string;
    direction: MessageDirection;
    sender_type: SenderType;
    body: string | null;
    status: string;
    created_at: string;
  }>(
    `select id, conversation_id, direction, sender_type, body, status, created_at
     from messages
     where conversation_id = $1
     order by created_at asc
     limit $2`,
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
  }));
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
