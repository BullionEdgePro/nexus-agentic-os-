import { getPool, findOrganizationByPhoneNumberId } from "@nexus/db";
import type { AgentConfig, InboundMessageEvent } from "@nexus/shared";
import { AnthropicDomainAgent } from "./domain-agent.js";
import type { ConversationTurn, DomainAgent } from "./types.js";

interface AgentConfigRow {
  id: string;
  organization_id: string;
  name: string;
  system_prompt: string;
  model: string;
  tools: string[];
  rag_collection: string | null;
  is_active: boolean;
}

function toAgentConfig(row: AgentConfigRow): AgentConfig {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    systemPrompt: row.system_prompt,
    model: row.model,
    tools: row.tools,
    ragCollection: row.rag_collection ?? undefined,
    isActive: row.is_active,
  };
}

/**
 * Switchboard: LangGraph node 1. Evaluates the inbound phone_number_id,
 * resolves the owning organization, and loads that organization's active
 * Domain Agent. Raw-API mode today (no graph runtime); swap this function's
 * body for a LangGraph StateGraph node if multi-step routing state is later
 * needed (e.g. sub-brand disambiguation within one WhatsApp number).
 */
export async function routeToDomainAgent(phoneNumberId: string): Promise<DomainAgent | null> {
  const organization = await findOrganizationByPhoneNumberId(phoneNumberId);
  if (!organization) return null;

  const { rows } = await getPool().query<AgentConfigRow>(
    `select id, organization_id, name, system_prompt, model, tools, rag_collection, is_active
     from agent_configs
     where organization_id = $1 and is_active = true
     order by created_at asc
     limit 1`,
    [organization.id]
  );
  if (!rows[0]) return null;

  return new AnthropicDomainAgent(toAgentConfig(rows[0]), organization.slug);
}

export async function loadRecentHistory(
  conversationId: string,
  limit = 20
): Promise<ConversationTurn[]> {
  const { rows } = await getPool().query<{ direction: "inbound" | "outbound"; body: string | null }>(
    `select direction, body from messages
     where conversation_id = $1
     order by created_at desc
     limit $2`,
    [conversationId, limit]
  );
  return rows
    .reverse()
    .filter((row) => row.body)
    .map((row) => ({
      role: row.direction === "inbound" ? "user" : "assistant",
      content: row.body as string,
    }));
}

export type { InboundMessageEvent };
