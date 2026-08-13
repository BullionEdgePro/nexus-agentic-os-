import { getPool } from "@nexus/db";
import type { AgentConfig, Employee, InboundMessageEvent, Organization } from "@nexus/shared";
import { composeTwinSystemPrompt } from "@nexus/employees";
// THE CUSTOMER REPLY PATH RUNS ON ANTHROPIC.
//
// GeminiDomainAgent is gone from this file. It is the same interface and the
// same per-tenant config — the agent's behaviour comes from its agent_configs
// row, not from the class — so a tenant's system prompt, tool allowlist and RAG
// collection are untouched by the swap. What changes is which vendor generates
// the words a customer reads, and which quota that draws on.
//
// The `model` column on each agent_configs row must hold an Anthropic model id
// after this. Migration 030 rewrites them; a row still naming a Gemini model
// would fail at request time with a 404 on every message that tenant receives.
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
 * The tenant an agent is being loaded for.
 *
 * Takes the resolved organization rather than a phone_number_id because a
 * number no longer identifies a tenant: several businesses can share one, and
 * which of them is being served is decided upstream by the business router. A
 * number-keyed lookup would quietly load the number owner's agent — and the
 * number owner's governance policy — for every business on the line.
 */
export type AgentTenant = Pick<Organization, "id" | "slug">;

/**
 * Switchboard: LangGraph node 1. Loads the tenant's active Domain Agent.
 * Raw-API mode today (no graph runtime); swap this function's body for a
 * LangGraph StateGraph node if multi-step routing state is later needed.
 */
export async function routeToDomainAgent(tenant: AgentTenant): Promise<DomainAgent | null> {
  const config = await loadActiveAgentConfig(tenant.id);
  if (!config) return null;
  return new AnthropicDomainAgent(config, tenant.slug);
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
  tenant: AgentTenant,
  employee: Employee | null
): Promise<DomainAgent | null> {
  const config = await loadActiveAgentConfig(tenant.id);
  if (!config) return null;

  if (!employee || !employee.twinEnabled) {
    return new AnthropicDomainAgent(config, tenant.slug);
  }

  const twinConfig: AgentConfig = {
    ...config,
    systemPrompt: composeTwinSystemPrompt({
      organizationPrompt: config.systemPrompt,
      employee,
    }),
    // An employee's own knowledge namespace wins over the tenant default so
    // one employee's SOPs never leak into another's answers.
    ragCollection: employee.knowledgeCollection ?? config.ragCollection,
  };

  return new AnthropicDomainAgent(twinConfig, tenant.slug, employee.id);
}

async function loadActiveAgentConfig(organizationId: string): Promise<AgentConfig | null> {
  const { rows } = await getPool().query<AgentConfigRow>(
    `select id, organization_id, name, system_prompt, model, tools, rag_collection, is_active
     from agent_configs
     where organization_id = $1 and is_active = true
     order by created_at asc
     limit 1`,
    [organizationId]
  );
  return rows[0] ? toAgentConfig(rows[0]) : null;
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
