import { getPool } from "./client.js";
import type { MessageDirection, MessageDto, SenderType } from "@nexus/shared";

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
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");

    const contactResult = await client.query<{ id: string; ai_paused_until: string | null }>(
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

    const conversationResult = await client.query<{ id: string; is_human_handoff: boolean }>(
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
      const inserted = await client.query<{ id: string; is_human_handoff: boolean }>(
        `insert into conversations (organization_id, contact_id) values ($1, $2)
         returning id, is_human_handoff`,
        [input.organizationId, contactId]
      );
      conversationId = inserted.rows[0].id;
      isHumanHandoff = inserted.rows[0].is_human_handoff;
    }

    const messageResult = await client.query<{ id: string }>(
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

    await client.query("commit");
    return {
      conversationId,
      contactId,
      messageId: messageResult.rows[0]?.id ?? null,
      isHumanHandoff,
      aiPausedUntil,
    };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export interface InsertOutboundMessageInput {
  organizationId: string;
  conversationId: string;
  contactId: string;
  senderType: Extract<SenderType, "ai_agent" | "human_agent" | "system">;
  senderId?: string;
  body: string;
  waMessageId?: string;
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
    `insert into messages
       (organization_id, conversation_id, contact_id, wa_message_id, direction, sender_type, sender_id, message_type, body, status)
     values ($1, $2, $3, $4, 'outbound', $5, $6, 'text', $7, 'sent')
     returning id, conversation_id, direction, sender_type, body, status, created_at`,
    [
      input.organizationId,
      input.conversationId,
      input.contactId,
      input.waMessageId ?? null,
      input.senderType,
      input.senderId ?? null,
      input.body,
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
