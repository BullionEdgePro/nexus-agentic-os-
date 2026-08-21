import { getPool } from "./client.js";
import type { BusinessSlug, ConversationSummary } from "@nexus/shared";

interface ConversationSummaryRow {
  id: string;
  contact_id: string;
  wa_id: string;
  display_name: string | null;
  status: ConversationSummary["status"];
  is_human_handoff: boolean;
  last_message_body: string | null;
  last_message_at: string | null;
}

function toSummary(row: ConversationSummaryRow): ConversationSummary {
  return {
    id: row.id,
    contactId: row.contact_id,
    contactWaId: row.wa_id,
    contactName: row.display_name,
    status: row.status,
    isHumanHandoff: row.is_human_handoff,
    lastMessagePreview: row.last_message_body,
    lastMessageAt: row.last_message_at,
  };
}

export async function getConversationsForOrganization(
  organizationId: string,
  limit = 50
): Promise<ConversationSummary[]> {
  const { rows } = await getPool().query<ConversationSummaryRow>(
    `select
       c.id,
       c.contact_id,
       ct.wa_id,
       ct.display_name,
       c.status,
       c.is_human_handoff,
       lm.body as last_message_body,
       lm.created_at as last_message_at
     from conversations c
     join contacts ct on ct.id = c.contact_id
     left join lateral (
       select body, created_at from messages
       where conversation_id = c.id
       order by created_at desc
       limit 1
     ) lm on true
     -- THE BUSINESS THE CUSTOMER IS TALKING TO, not the one that owns the
     -- number. All five answer on Zipicka's, so filtering on organization_id
     -- showed Juris Prime an empty inbox while its own customers were waiting,
     -- and showed Zipicka three conversations it could not help with.
     -- Migration 054 widened the policy so the serving business can read these
     -- at all; this decides which of them are its own.
     where coalesce(c.routed_organization_id, c.organization_id) = $1
     order by coalesce(lm.created_at, c.opened_at) desc
     limit $2`,
    [organizationId, limit]
  );
  return rows.map(toSummary);
}

export interface ConversationLookup {
  id: string;
  organizationId: string;
  contactId: string;
  contactWaId: string;
  organizationSlug: BusinessSlug;
  phoneNumberId: string;
}

export async function findConversationById(conversationId: string): Promise<ConversationLookup | null> {
  const { rows } = await getPool().query<{
    id: string;
    organization_id: string;
    contact_id: string;
    wa_id: string;
    slug: BusinessSlug;
    whatsapp_phone_number_id: string;
  }>(
    `select c.id, c.organization_id, c.contact_id, ct.wa_id, o.slug, o.whatsapp_phone_number_id
     from conversations c
     join organizations o on o.id = c.organization_id
     join contacts ct on ct.id = c.contact_id
     where c.id = $1`,
    [conversationId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    contactWaId: row.wa_id,
    contactId: row.contact_id,
    organizationSlug: row.slug,
    phoneNumberId: row.whatsapp_phone_number_id,
  };
}

/**
 * Why a conversation changed hands. See migration 062.
 *
 * Constrained rather than free text because code branches on it, and matched
 * by a CHECK constraint so a value that only exists in TypeScript cannot be
 * written.
 */
export type CustodyReason =
  | "agent_escalated"
  | "human_replied"
  | "taken_by_employee"
  | "manual_toggle"
  | "stale_release";

/**
 * Hand a conversation to a person, or hand it back to the agent.
 *
 * THE REASON IS REQUIRED AND THE TRACE IS WRITTEN HERE, not at the call sites.
 * Those two decisions are the entire point of migration 062: six callers used
 * to flip this boolean and none of them recorded which one had, so the moment
 * the flag went back to false the fact it had ever been held was gone.
 *
 * That absence cost an afternoon on 2026-08-20 -- a customer waiting 28 hours,
 * a flag reading false, and a finding that said to check a reply pipeline which
 * turned out to be working perfectly. The truth was a colleague who answered on
 * the 10th and never came back.
 *
 * Putting the write here rather than in the callers means a seventh caller
 * cannot forget it, and requiring `reason` means it cannot be added without
 * saying why. An audit trail every caller has to remember is a convention, and
 * this codebase has spent nine defects learning what a convention is worth.
 *
 * ONE STATEMENT, AND ONLY WHEN SOMETHING CHANGES. `is distinct from` makes the
 * update a no-op when the flag already holds the value asked for, and the
 * custody row is written from that same statement's output -- so a conversation
 * held by a person does not accrue a row per inbound message, and the trace
 * cannot disagree with the flag it describes.
 */
export async function setConversationHandoff(
  conversationId: string,
  isHumanHandoff: boolean,
  reason: CustodyReason,
  actor: string | null = null
): Promise<void> {
  await getPool().query(
    `with changed as (
       update conversations
          set is_human_handoff = $2
        where id = $1
          and is_human_handoff is distinct from $2
       returning id, organization_id
     )
     insert into conversation_custody (organization_id, conversation_id, held, reason, actor)
     select organization_id, id, $2, $3, $4 from changed`,
    [conversationId, isHumanHandoff, reason, actor]
  );
}

export interface CustodyEvent {
  held: boolean;
  reason: CustodyReason;
  actor: string | null;
  createdAt: string;
}

/**
 * How a conversation has changed hands, newest first.
 *
 * AN EMPTY HISTORY MEANS "NOT RECORDED", NEVER "NEVER HELD". Migration 062
 * deliberately backfills nothing: every handover before it left no trace and
 * there is nothing honest to reconstruct one from. Callers that read an empty
 * list as "the agent has always had this" would be repeating the exact mistake
 * -- an absent record answering a question it was never asked -- that this
 * table exists to end.
 */
export async function listCustody(
  conversationId: string,
  limit = 20
): Promise<CustodyEvent[]> {
  const { rows } = await getPool().query<{
    held: boolean;
    reason: CustodyReason;
    actor: string | null;
    created_at: string;
  }>(
    `select held, reason, actor, created_at
       from conversation_custody
      where conversation_id = $1
      order by created_at desc
      limit $2`,
    [conversationId, limit]
  );
  return rows.map((r) => ({
    held: r.held,
    reason: r.reason,
    actor: r.actor,
    createdAt: r.created_at,
  }));
}

/** Pauses the AI agent for a contact for the given number of hours (default 24, per spec). */
export async function pauseAiForContact(contactId: string, hours = 24): Promise<void> {
  await getPool().query(
    `update contacts set ai_paused_until = now() + ($2 || ' hours')::interval where id = $1`,
    [contactId, hours]
  );
}
