import type { ScheduledMessageStatus } from "@nexus/shared";
import { getPool } from "./client.js";

/**
 * A reply written now to be sent later.
 *
 * The read model the inbox shows and the sweep writes. Statuses: pending →
 * sending → sent | failed, and pending → cancelled. 'sending' is the claim the
 * sweep takes (see claimDueScheduledMessages) so an overlapping sweep cannot
 * send the same row twice.
 */
export interface ScheduledMessage {
  id: string;
  conversationId: string;
  body: string;
  sendAt: string;
  status: ScheduledMessageStatus;
  createdBy: string | null;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
}

interface ScheduledMessageRow {
  id: string;
  conversation_id: string;
  body: string;
  send_at: string;
  status: ScheduledMessage["status"];
  created_by: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
}

function toModel(r: ScheduledMessageRow): ScheduledMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    body: r.body,
    sendAt: r.send_at,
    status: r.status,
    createdBy: r.created_by,
    error: r.error,
    createdAt: r.created_at,
    sentAt: r.sent_at,
  };
}

const COLS = "id, conversation_id, body, send_at, status, created_by, error, created_at, sent_at";

export async function createScheduledMessage(input: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  body: string;
  sendAt: Date;
  createdBy: string | null;
}): Promise<ScheduledMessage> {
  const { rows } = await getPool().query<ScheduledMessageRow>(
    `insert into scheduled_messages (organization_id, conversation_id, contact_id, body, send_at, created_by)
     values ($1, $2, $3, $4, $5, $6)
     returning ${COLS}`,
    [input.organizationId, input.conversationId, input.contactId, input.body, input.sendAt, input.createdBy]
  );
  return toModel(rows[0]);
}

/** The still-pending sends on one conversation, soonest first. */
export async function listPendingScheduledMessages(conversationId: string): Promise<ScheduledMessage[]> {
  const { rows } = await getPool().query<ScheduledMessageRow>(
    `select ${COLS} from scheduled_messages
      where conversation_id = $1 and status = 'pending'
      order by send_at asc`,
    [conversationId]
  );
  return rows.map(toModel);
}

/**
 * Cancel a pending send. Scoped to the conversation so a stray id from another
 * thread cannot cancel it, and guarded on 'pending' so a message already firing
 * or sent cannot be "cancelled" after the fact.
 */
export async function cancelScheduledMessage(conversationId: string, id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `update scheduled_messages set status = 'cancelled'
      where id = $1 and conversation_id = $2 and status = 'pending'`,
    [id, conversationId]
  );
  return (rowCount ?? 0) > 0;
}

export interface DueScheduledMessage {
  id: string;
  organizationId: string;
  conversationId: string;
  contactId: string;
  body: string;
  createdBy: string | null;
}

/**
 * Claim the due pending sends for a sweep, atomically.
 *
 * The `for update skip locked` sub-select plus the status flip to 'sending' is
 * the whole safety property: two sweeps running at once each take a disjoint set
 * and neither can grab a row the other is already sending. A row left in
 * 'sending' by a crashed sweep is visible for a human to see rather than
 * silently retried — deliberately, since the failure a scheduled send must never
 * have is sending twice.
 */
export async function claimDueScheduledMessages(limit = 50): Promise<DueScheduledMessage[]> {
  const { rows } = await getPool().query<{
    id: string;
    organization_id: string;
    conversation_id: string;
    contact_id: string;
    body: string;
    created_by: string | null;
  }>(
    `update scheduled_messages set status = 'sending'
      where id in (
        select id from scheduled_messages
         where status = 'pending' and send_at <= now()
         order by send_at asc
         limit $1
         for update skip locked
      )
     returning id, organization_id, conversation_id, contact_id, body, created_by`,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    organizationId: r.organization_id,
    conversationId: r.conversation_id,
    contactId: r.contact_id,
    body: r.body,
    createdBy: r.created_by,
  }));
}

export async function markScheduledMessageSent(id: string, waMessageId: string | null): Promise<void> {
  await getPool().query(
    `update scheduled_messages set status = 'sent', sent_at = now(), wa_message_id = $2, error = null where id = $1`,
    [id, waMessageId]
  );
}

export async function markScheduledMessageFailed(id: string, error: string): Promise<void> {
  await getPool().query(`update scheduled_messages set status = 'failed', error = $2 where id = $1`, [
    id,
    error.slice(0, 500),
  ]);
}
