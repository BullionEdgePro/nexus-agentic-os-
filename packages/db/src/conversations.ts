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
     where c.organization_id = $1
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

export async function setConversationHandoff(
  conversationId: string,
  isHumanHandoff: boolean
): Promise<void> {
  await getPool().query(`update conversations set is_human_handoff = $2 where id = $1`, [
    conversationId,
    isHumanHandoff,
  ]);
}

/** Pauses the AI agent for a contact for the given number of hours (default 24, per spec). */
export async function pauseAiForContact(contactId: string, hours = 24): Promise<void> {
  await getPool().query(
    `update contacts set ai_paused_until = now() + ($2 || ' hours')::interval where id = $1`,
    [contactId, hours]
  );
}
