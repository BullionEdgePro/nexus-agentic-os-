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
  const { rows } = await getPool().query<{
    inbox_stages: string[] | null;
    sla_minutes: number | null;
    auto_assign: boolean | null;
  }>(
    `select inbox_stages, sla_minutes, auto_assign from organizations where id = $1`,
    [organizationId]
  );
  const r = rows[0];
  return {
    stages: r?.inbox_stages?.length ? r.inbox_stages : DEFAULT_INBOX_STAGES,
    slaMinutes: r?.sla_minutes ?? DEFAULT_SLA_MINUTES,
    isDefault: !r?.inbox_stages?.length && r?.sla_minutes == null,
    autoAssign: r?.auto_assign ?? false,
  };
}

/** Partial update; null resets a setting to its default. */
export async function updateInboxSettings(
  organizationId: string,
  input: { stages?: string[] | null; slaMinutes?: number | null; autoAssign?: boolean }
): Promise<InboxSettings> {
  await getPool().query(
    `update organizations set
       inbox_stages = case when $2::boolean then $3::text[] else inbox_stages end,
       sla_minutes  = case when $4::boolean then $5::integer else sla_minutes end,
       auto_assign  = case when $6::boolean then $7::boolean else auto_assign end
     where id = $1`,
    [
      organizationId,
      input.stages !== undefined,
      input.stages ?? null,
      input.slaMinutes !== undefined,
      input.slaMinutes ?? null,
      input.autoAssign !== undefined,
      input.autoAssign ?? false,
    ]
  );
  return getInboxSettings(organizationId);
}

// ============================================================
// Round-robin auto-assign (migration 092)
// ============================================================

/**
 * Is this chat waiting for a person to be given it? Nobody owns it.
 *
 * It used to also require `not is_human_handoff`, on the theory that a
 * handed-over chat "has somebody". It doesn't: the flag means the AI promised
 * the customer a person, and nothing assigned one. On 2026-09-30 ten open chats
 * were in exactly that state, skipped by auto-assign and by the overnight
 * sweep. Giving one an owner never unmutes the AI — the handoff flag still
 * holds it silent — so the only change is that somebody now has the promise.
 * Read in the caller's scope — the reply pipeline's, the number owner's.
 */
export async function conversationNeedsAssignee(conversationId: string): Promise<boolean> {
  const { rows } = await getPool().query<{ needs: boolean }>(
    `select (employee_id is null) as needs from conversations where id = $1`,
    [conversationId]
  );
  return rows[0]?.needs ?? false;
}

/**
 * How loaded each candidate is: open chats they hold, and when they were last
 * handed one automatically. Read in the SERVING business's scope — the
 * candidates are its people.
 */
export async function autoAssignLoad(
  employeeIds: string[]
): Promise<Map<string, { open: number; lastAutoAt: string | null }>> {
  const out = new Map<string, { open: number; lastAutoAt: string | null }>();
  if (employeeIds.length === 0) return out;
  const { rows } = await getPool().query<{ id: string; open: string; last_auto_at: string | null }>(
    `select e.id,
            (select count(*) from conversations c
              where c.employee_id = e.id and c.status in ('open', 'pending'))::text as open,
            e.last_auto_assigned_at as last_auto_at
       from employees e
      where e.id = any($1::uuid[])`,
    [employeeIds]
  );
  for (const r of rows) out.set(r.id, { open: Number(r.open), lastAutoAt: r.last_auto_at });
  return out;
}

/**
 * Give the chat to this person — only if it is STILL unassigned.
 *
 * The condition is in the UPDATE itself, so a colleague assigning it by hand in
 * the same instant wins and this does nothing. Written in the caller's (owner's)
 * scope: the conversations row belongs to the number's owner. The timeline line
 * says who did it — "Auto-assign" — so nobody wonders how the chat got there.
 */
export async function claimForAutoAssign(
  conversationId: string,
  employeeId: string,
  employeeName: string
): Promise<boolean> {
  const { rows } = await getPool().query<{ id: string }>(
    `with claimed as (
       update conversations
          set employee_id = $2::uuid
        where id = $1 and employee_id is null
        returning id, organization_id
     ), noted as (
       insert into conversation_events
         (organization_id, conversation_id, kind, actor, actor_name, subject_name)
       select organization_id, id, 'assigned', 'auto-assign', 'Auto-assign', $3 from claimed
     )
     select id from claimed`,
    [conversationId, employeeId, employeeName]
  );
  return rows.length > 0;
}

/**
 * Chats still waiting for a person, in businesses that turned auto-assign on —
 * for the after-hours sweep (services/availability.ts assignWaitingChats).
 *
 * WHY A SWEEP AT ALL: auto-assign fires when a customer message arrives. A chat
 * that arrived at 2am found nobody on shift, stayed unassigned, and — if the
 * customer said nothing more — was never looked at again when the shift
 * started. This is the list of those chats.
 *
 * WhatsApp only: that is the channel the reply pipeline assigns on. Only chats
 * whose customer wrote in the last 7 days — an unanswered month-old thread is
 * not something to drop on whoever happens to be on shift — except a chat the
 * AI handed to a person, which stays eligible for 30 days: that customer was
 * promised someone. Handed-over chats first, then oldest customer message
 * first, so a broken promise and the longest wait are handed out before the
 * rest. Cross-tenant by nature: call it inside withAllTenants.
 */
export async function listChatsWaitingForAssignee(
  limit = 200
): Promise<Array<{ conversationId: string; servingOrganizationId: string }>> {
  const { rows } = await getPool().query<{ id: string; serving_id: string }>(
    `select c.id, coalesce(c.routed_organization_id, c.organization_id) as serving_id
       from conversations c
       join organizations o on o.id = coalesce(c.routed_organization_id, c.organization_id)
       join lateral (
         select max(m.created_at) as last_in
           from messages m
          where m.conversation_id = c.id and m.direction = 'inbound'
       ) li on true
      where o.auto_assign
        and c.channel = 'whatsapp'
        and c.employee_id is null
        and c.status in ('open', 'pending')
        and (li.last_in > now() - interval '7 days'
             or (c.is_human_handoff and li.last_in > now() - interval '30 days'))
      order by c.is_human_handoff desc, li.last_in asc
      limit $1`,
    [limit]
  );
  return rows.map((r) => ({ conversationId: r.id, servingOrganizationId: r.serving_id }));
}

/** The "round" in round-robin — stamped in the SERVING business's scope. */
export async function stampAutoAssigned(employeeId: string): Promise<void> {
  await getPool().query(`update employees set last_auto_assigned_at = now() where id = $1`, [employeeId]);
}

// ============================================================
// Telling a person a chat is now theirs
// ============================================================

export interface AssignmentAlertContext {
  stillTheirs: boolean;
  employeeActive: boolean;
  employeeName: string;
  employeeWhatsApp: string | null;
  contactName: string;
  servingOrganizationId: string;
  servingSlug: string;
  servingName: string;
  ownerOrganizationId: string;
  ownerPhoneNumberId: string | null;
}

/**
 * Everything the assignment alert needs, in one read: is the chat still with
 * this person (it may have been reassigned in the second before the alert
 * went), who the customer is, which business serves them, and which number the
 * business speaks from. Spans the number's owner and the serving business, so
 * it is read inside withAllTenants.
 */
export async function getAssignmentAlertContext(
  conversationId: string,
  employeeId: string
): Promise<AssignmentAlertContext | null> {
  const { rows } = await getPool().query<{
    still_theirs: boolean;
    is_active: boolean;
    full_name: string;
    whatsapp_number: string | null;
    contact_name: string;
    serving_id: string;
    serving_slug: string;
    serving_name: string;
    owner_id: string;
    phone_number_id: string | null;
  }>(
    `select (c.employee_id = e.id) as still_theirs,
            e.is_active, e.full_name, e.whatsapp_number,
            coalesce(nullif(trim(ct.display_name), ''), 'a customer') as contact_name,
            srv.id as serving_id, srv.slug as serving_slug, srv.name as serving_name,
            own.id as owner_id, own.whatsapp_phone_number_id as phone_number_id
       from conversations c
       join organizations own on own.id = c.organization_id
       join organizations srv on srv.id = coalesce(c.routed_organization_id, c.organization_id)
       join employees e on e.id = $2
       left join contacts ct on ct.id = c.contact_id
      where c.id = $1`,
    [conversationId, employeeId]
  );
  const r = rows[0];
  if (!r) return null;
  return {
    stillTheirs: r.still_theirs,
    employeeActive: r.is_active,
    employeeName: r.full_name,
    employeeWhatsApp: r.whatsapp_number,
    contactName: r.contact_name,
    servingOrganizationId: r.serving_id,
    servingSlug: r.serving_slug,
    servingName: r.serving_name,
    ownerOrganizationId: r.owner_id,
    ownerPhoneNumberId: r.phone_number_id,
  };
}

/**
 * An APPROVED template by name on this business's WhatsApp account, or null.
 * Business-initiated WhatsApp messages must be a Meta-approved template; with
 * none approved, the caller sends nothing rather than something Meta rejects.
 */
export async function findApprovedTemplateByName(
  organizationId: string,
  name: string
): Promise<{ name: string; language: string; bodyParamCount: number } | null> {
  const { rows } = await getPool().query<{ meta_template_name: string; language: string; body_param_count: number }>(
    `select meta_template_name, language, body_param_count
       from message_templates
      where organization_id = $1 and meta_template_name = $2 and is_approved
      order by synced_at desc nulls last
      limit 1`,
    [organizationId, name]
  );
  const r = rows[0];
  return r ? { name: r.meta_template_name, language: r.language, bodyParamCount: r.body_param_count } : null;
}
