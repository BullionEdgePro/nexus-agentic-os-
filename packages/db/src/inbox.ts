/**
 * The team-inbox state that is not a message: who resolved a thread, what has
 * happened to it, who has read it, the notes a team keeps on it, and the
 * per-business inbox settings. See migration 090.
 *
 * The conversation-scoped functions run in whatever scope the caller is in; the
 * /api/conversations routes run cross-tenant (withAllTenants), and every write
 * takes its organization from the conversation row itself, never the caller.
 */
import { getPool } from "./client.js";
import type {
  ConversationEvent,
  ConversationEventKind,
  ConversationNote,
  InboxSettings,
} from "@nexus/shared";

// ============================================================
// Resolve / reopen
// ============================================================

/**
 * Mark a conversation resolved, or open it again.
 *
 * ONE STATEMENT, AND ONLY WHEN SOMETHING CHANGES — the same shape as
 * setConversationHandoff: the event row is written from the update's own output,
 * so a second click writes nothing and the timeline cannot disagree with the
 * status it describes. Returns whether anything changed.
 */
export async function setConversationStatus(
  conversationId: string,
  status: "open" | "resolved",
  actor: string | null,
  actorName: string | null
): Promise<boolean> {
  const kind: ConversationEventKind = status === "resolved" ? "resolved" : "reopened";
  const { rowCount } = await getPool().query(
    `with changed as (
       update conversations
          set status    = $2,
              closed_at = case when $2 = 'resolved' then now() else null end,
              closed_by = case when $2 = 'resolved' then $3 else null end
        where id = $1
          and status is distinct from $2
          -- Only open/pending/resolved move here; a hard 'closed' stays closed.
          and status in ('open', 'pending', 'resolved')
       returning id, organization_id
     )
     insert into conversation_events (organization_id, conversation_id, kind, actor, actor_name)
     select organization_id, id, $4, $3, $5 from changed`,
    [conversationId, status, actor, kind, actorName]
  );
  return (rowCount ?? 0) > 0;
}

/** Record an assignment change on the thread's timeline. */
export async function recordAssignmentEvent(
  conversationId: string,
  assigneeName: string | null,
  actor: string | null,
  actorName: string | null
): Promise<void> {
  await getPool().query(
    `insert into conversation_events
       (organization_id, conversation_id, kind, actor, actor_name, subject_name)
     select organization_id, id, $2, $3, $4, $5 from conversations where id = $1`,
    [conversationId, assigneeName ? "assigned" : "unassigned", actor, actorName, assigneeName]
  );
}

/** A thread's events, oldest first (by seq — see migration 063). */
export async function listConversationEvents(
  conversationId: string,
  limit = 200
): Promise<ConversationEvent[]> {
  const { rows } = await getPool().query<{
    id: string;
    kind: ConversationEventKind;
    actor_name: string | null;
    subject_name: string | null;
    created_at: string;
  }>(
    `select id, kind, actor_name, subject_name, created_at
       from conversation_events
      where conversation_id = $1
      order by seq desc
      limit $2`,
    [conversationId, limit]
  );
  return rows.reverse().map((r) => ({
    id: r.id,
    kind: r.kind,
    actorName: r.actor_name,
    subjectName: r.subject_name,
    createdAt: r.created_at,
  }));
}

/**
 * Names for the actor ids recorded in custody and events — employee ids and
 * admin ids, both stored as text. An id that matches nobody (an old session
 * subject, a departed account) is simply absent from the map.
 */
export async function resolveActorNames(ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter(Boolean))];
  if (wanted.length === 0) return new Map();
  const { rows } = await getPool().query<{ id: string; name: string }>(
    `select id::text as id, full_name as name from employees where id::text = any($1::text[])
     union all
     select id::text as id, full_name as name from admins where id::text = any($1::text[])`,
    [wanted]
  );
  return new Map(rows.map((r) => [r.id, r.name]));
}

// ============================================================
// Per-person read state
// ============================================================

/**
 * Record that `reader` has seen this conversation up to now.
 *
 * The row is filed under the SERVING business (migration 090, part 3), taken
 * from the conversation, so the list query — which runs under that business's
 * scope — can see it.
 */
export async function markConversationRead(conversationId: string, reader: string): Promise<void> {
  await getPool().query(
    `insert into conversation_reads (conversation_id, reader, organization_id, last_read_at)
     select id, $2, coalesce(routed_organization_id, organization_id), now()
       from conversations where id = $1
     on conflict (conversation_id, reader) do update set last_read_at = now()`,
    [conversationId, reader]
  );
}

// ============================================================
// Notes timeline
// ============================================================

export async function listConversationNotes(conversationId: string): Promise<ConversationNote[]> {
  const { rows } = await getPool().query<{
    id: string;
    author: string | null;
    author_name: string | null;
    body: string;
    created_at: string;
  }>(
    `select id, author, author_name, body, created_at
       from conversation_notes
      where conversation_id = $1
      order by created_at desc
      limit 200`,
    [conversationId]
  );
  return rows.map((r) => ({
    id: r.id,
    author: r.author,
    authorName: r.author_name,
    body: r.body,
    createdAt: r.created_at,
  }));
}

export async function addConversationNote(input: {
  conversationId: string;
  author: string | null;
  authorName: string | null;
  body: string;
}): Promise<ConversationNote | null> {
  const { rows } = await getPool().query<{
    id: string;
    author: string | null;
    author_name: string | null;
    body: string;
    created_at: string;
  }>(
    `insert into conversation_notes (organization_id, conversation_id, author, author_name, body)
     select organization_id, id, $2, $3, $4 from conversations where id = $1
     returning id, author, author_name, body, created_at`,
    [input.conversationId, input.author, input.authorName, input.body]
  );
  const r = rows[0];
  if (!r) return null;
  return { id: r.id, author: r.author, authorName: r.author_name, body: r.body, createdAt: r.created_at };
}

/**
 * Delete a note — only its author's own. A team timeline is not a place where
 * one colleague silently erases another's words; the author check is the
 * whole point of the extra argument.
 */
export async function deleteConversationNote(
  conversationId: string,
  noteId: string,
  author: string | null
): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from conversation_notes
      where id = $1 and conversation_id = $2 and author is not distinct from $3`,
    [noteId, conversationId, author]
  );
  return (rowCount ?? 0) > 0;
}

// ============================================================
// Per-business inbox settings
// ============================================================

/** The defaults a business has until it chooses its own. */
export const DEFAULT_INBOX_STAGES = ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"];
export const DEFAULT_SLA_MINUTES = 180;

export async function getInboxSettings(organizationId: string): Promise<InboxSettings> {
  const { rows } = await getPool().query<{ inbox_stages: string[] | null; sla_minutes: number | null }>(
    `select inbox_stages, sla_minutes from organizations where id = $1`,
    [organizationId]
  );
  const r = rows[0];
  return {
    stages: r?.inbox_stages?.length ? r.inbox_stages : DEFAULT_INBOX_STAGES,
    slaMinutes: r?.sla_minutes ?? DEFAULT_SLA_MINUTES,
    isDefault: !r?.inbox_stages?.length && r?.sla_minutes == null,
  };
}

/** Partial update; null resets a setting to its default. */
export async function updateInboxSettings(
  organizationId: string,
  input: { stages?: string[] | null; slaMinutes?: number | null }
): Promise<InboxSettings> {
  await getPool().query(
    `update organizations set
       inbox_stages = case when $2::boolean then $3::text[] else inbox_stages end,
       sla_minutes  = case when $4::boolean then $5::integer else sla_minutes end
     where id = $1`,
    [
      organizationId,
      input.stages !== undefined,
      input.stages ?? null,
      input.slaMinutes !== undefined,
      input.slaMinutes ?? null,
    ]
  );
  return getInboxSettings(organizationId);
}
