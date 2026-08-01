import { getPool, findOrganizationByPhoneNumberId } from "@nexus/db";
import type { AgentConfig, BusinessSlug, Employee, InboundMessageEvent } from "@nexus/shared";
import { composeTwinSystemPrompt } from "@nexus/employees";
import { GeminiDomainAgent } from "./gemini-domain-agent.js";
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
  const resolved = await loadActiveAgentConfig(phoneNumberId);
  if (!resolved) return null;
  return new GeminiDomainAgent(resolved.config, resolved.slug);
}

/**
 * Employee-aware routing (Employee Agent Layer).
 *
 * Same tenant agent, with the employee's twin persona layered on top of the
 * organization's system prompt. Passing a null employee — or one whose twin
 * is disabled — returns exactly what routeToDomainAgent would, so a tenant
 * that has not onboarded employees is byte-for-byte unaffected by this path.
 */
export async function routeToEmployeeTwin(
  phoneNumberId: string,
  employee: Employee | null
): Promise<DomainAgent | null> {
  const resolved = await loadActiveAgentConfig(phoneNumberId);
  if (!resolved) return null;

  if (!employee || !employee.twinEnabled) {
    return new GeminiDomainAgent(resolved.config, resolved.slug);
  }

  const twinConfig: AgentConfig = {
    ...resolved.config,
    systemPrompt: composeTwinSystemPrompt({
      organizationPrompt: resolved.config.systemPrompt,
      employee,
    }),
    // An employee's own knowledge namespace wins over the tenant default so
    // one employee's SOPs never leak into another's answers.
    ragCollection: employee.knowledgeCollection ?? resolved.config.ragCollection,
  };

  return new GeminiDomainAgent(twinConfig, resolved.slug);
}

async function loadActiveAgentConfig(
  phoneNumberId: string
): Promise<{ config: AgentConfig; slug: BusinessSlug } | null> {
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

  return { config: toAgentConfig(rows[0]), slug: organization.slug };
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
