import { getPool, withServingTenant } from "@nexus/db";
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
import { hasAnyoneOnARota } from "./availability.js";
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
 * Tools the business cannot actually perform, removed before the model sees them.
 *
 * A tool in the schema is a capability the model can announce, and it announces
 * them before it calls them: "let me check the diary for you" is said first and
 * discovered to be pointless second. `check_availability` does answer honestly
 * when it finally runs — "Nobody is scheduled to be available in the next week" —
 * but a customer of a law firm reads that as a full diary, not as a business that
 * has never set a rota.
 *
 * On 2026-08-24 that was three of the four businesses with booking enabled. The
 * operators had been saying so per business since 20 August.
 *
 * Withholding the tool rather than adding a note to the prompt, because the two
 * are not equally strong: a note asks the model to be careful, and an absent
 * tool cannot be called or advertised at all. Same rule the escalation path
 * follows in `describeNobodyToEscalateTo` — do not offer what nobody will do.
 */
const TOOLS_NEEDING_A_ROTA = new Set(["check_availability", "book_appointment"]);

async function withoutUnperformableTools(config: AgentConfig, organizationId: string): Promise<AgentConfig> {
  if (!config.tools.some((tool) => TOOLS_NEEDING_A_ROTA.has(tool))) return config;

  // Only asked when a booking tool is configured, so a business that never had
  // one pays nothing for this. Failing OPEN — a rota lookup that throws leaves
  // the tools in place — because the cost of being wrong the other way is an
  // agent that silently stops being able to book for a business that can.
  const anyone = await hasAnyoneOnARota(organizationId).catch(() => true);
  if (anyone) return config;

  return { ...config, tools: config.tools.filter((tool) => !TOOLS_NEEDING_A_ROTA.has(tool)) };
}

/**
 * The tools this business's agent would actually be given, right now.
 *
 * Exported so a diagnostic can ask the question without constructing an agent
 * and a model client to observe one array. `self-check` uses it to assert the
 * property that matters -- booking is offered if and only if somebody is on a
 * rota -- from inside the OWNER's transaction, which is where the rota read is
 * one plain query away from being the twelfth instance of the shared-number
 * trap.
 */
export async function effectiveToolsFor(tenant: AgentTenant): Promise<string[] | null> {
  const config = await loadActiveAgentConfig(tenant.id);
  if (!config) return null;
  return (await withoutUnperformableTools(config, tenant.id)).tools;
}

/**
 * Switchboard: LangGraph node 1. Loads the tenant's active Domain Agent.
 * Raw-API mode today (no graph runtime); swap this function's body for a
 * LangGraph StateGraph node if multi-step routing state is later needed.
 */
export async function routeToDomainAgent(tenant: AgentTenant): Promise<DomainAgent | null> {
  const config = await loadActiveAgentConfig(tenant.id);
  if (!config) return null;
  return new AnthropicDomainAgent(await withoutUnperformableTools(config, tenant.id), tenant.slug);
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
    return new AnthropicDomainAgent(await withoutUnperformableTools(config, tenant.id), tenant.slug);
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

  return new AnthropicDomainAgent(
    await withoutUnperformableTools(twinConfig, tenant.id),
    tenant.slug,
    employee.id
  );
}

/**
 * THE SHARED-NUMBER TRAP, FOURTH INSTANCE — AND THE ONE THAT COST A CUSTOMER.
 *
 * `agent_configs` is under RLS. All five businesses answer on Zipicka's number,
 * so the reply path's transaction is scoped to the OWNER, and a plain read here
 * for a SERVING business matched nothing: not an error, zero rows, which the
 * caller correctly reads as "this business has no agent" and returns on.
 *
 * The consequence was silence. Found in production on 2026-08-18 by
 * `customer-waiting`: somebody picked option 2 from the triage menu at 17:27 on
 * 17 August, was routed to `juris-prime` — the log says so — and received
 * nothing at all for seventeen hours. `juris-prime` has an active agent the
 * whole time; it was simply invisible from inside Zipicka's transaction.
 * Verified afterwards by reading it as `nexus_app` with `app.current_org` set to
 * Zipicka: 0 rows.
 *
 * That means EVERY customer the switchboard routed away from the number's owner
 * got no reply, which is four of the five businesses.
 *
 * The same mistake has now been made in `hasStaffOnShift` ("you have no staff at
 * all"), in the phrase lookup, and in the stale-handoff release. Each time it
 * fails toward silence, and each time it looks exactly like a business with
 * nothing configured. `withServingTenant` is the fix and is a safe drop-in: with
 * no ambient transaction it degrades to `withTenant`, so callers outside the
 * message pipeline behave as before.
 */
async function loadActiveAgentConfig(organizationId: string): Promise<AgentConfig | null> {
  return withServingTenant(organizationId, async () => {
    const { rows } = await getPool().query<AgentConfigRow>(
      `select id, organization_id, name, system_prompt, model, tools, rag_collection, is_active
       from agent_configs
       where organization_id = $1 and is_active = true
       order by created_at asc
       limit 1`,
      [organizationId]
    );
    return rows[0] ? toAgentConfig(rows[0]) : null;
  });
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
