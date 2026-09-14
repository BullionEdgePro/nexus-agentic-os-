import { getPool } from "./client.js";

/**
 * Calls logged against a conversation.
 *
 * Unlike a message, a call has no body — it has a direction, an outcome and a
 * duration. These reads and writes run under the conversation-scoped routes,
 * which resolve the tenant cross-tenant (withAllTenants) and then hand this
 * layer the organization and conversation ids explicitly, so every query is
 * pinned to one thread by id rather than leaning on RLS to scope it.
 */
export type CallDirection = "inbound" | "outbound";
export type CallOutcome = "answered" | "no-answer" | "voicemail" | "busy" | "failed";

export interface CallLog {
  id: string;
  conversationId: string | null;
  contactId: string | null;
  direction: CallDirection;
  outcome: CallOutcome;
  durationSeconds: number | null;
  notes: string | null;
  loggedBy: string | null;
  occurredAt: string;
  createdAt: string;
}

interface CallLogRow {
  id: string;
  conversation_id: string | null;
  contact_id: string | null;
  direction: CallDirection;
  outcome: CallOutcome;
  duration_seconds: number | null;
  notes: string | null;
  logged_by: string | null;
  occurred_at: string;
  created_at: string;
}

const toCallLog = (r: CallLogRow): CallLog => ({
  id: r.id,
  conversationId: r.conversation_id,
  contactId: r.contact_id,
  direction: r.direction,
  outcome: r.outcome,
  durationSeconds: r.duration_seconds,
  notes: r.notes,
  loggedBy: r.logged_by,
  occurredAt: r.occurred_at,
  createdAt: r.created_at,
});

/** The calls logged on one conversation, most recent first. */
export async function listCallLogs(conversationId: string): Promise<CallLog[]> {
  const { rows } = await getPool().query<CallLogRow>(
    `select id, conversation_id, contact_id, direction, outcome,
            duration_seconds, notes, logged_by, occurred_at, created_at
       from call_logs
      where conversation_id = $1
      order by occurred_at desc`,
    [conversationId]
  );
  return rows.map(toCallLog);
}

/** Record a call. The org and contact come from the resolved conversation. */
export async function createCallLog(input: {
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  direction: CallDirection;
  outcome: CallOutcome;
  durationSeconds: number | null;
  notes: string | null;
  loggedBy: string | null;
  occurredAt?: Date;
}): Promise<CallLog> {
  const { rows } = await getPool().query<CallLogRow>(
    `insert into call_logs
       (organization_id, conversation_id, contact_id, direction, outcome,
        duration_seconds, notes, logged_by, occurred_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, coalesce($9, now()))
     returning id, conversation_id, contact_id, direction, outcome,
               duration_seconds, notes, logged_by, occurred_at, created_at`,
    [
      input.organizationId,
      input.conversationId,
      input.contactId,
      input.direction,
      input.outcome,
      input.durationSeconds,
      input.notes,
      input.loggedBy,
      input.occurredAt ?? null,
    ]
  );
  return toCallLog(rows[0]);
}

/**
 * Delete a logged call. Scoped by conversation as well as id so a stray id from
 * another thread (which RLS already hides under a scoped context) cannot report
 * a delete that did not happen.
 */
export async function deleteCallLog(conversationId: string, id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from call_logs where id = $1 and conversation_id = $2`,
    [id, conversationId]
  );
  return (rowCount ?? 0) > 0;
}
