/**
 * What the agent is told to be, and every version of it there has been.
 *
 * ============================================================
 * THE ONE SETTING THAT SHAPES EVERY REPLY
 * ============================================================
 *
 * More than the knowledge base, which only supplies facts. More than the
 * procedures, which apply only to situations they match. The system prompt is
 * the standing instruction underneath all of it, and until migration 068 the
 * only way to change it was a CLI script run by whoever had SSH.
 *
 * ============================================================
 * WHY EVERY WRITE KEEPS WHAT IT REPLACED
 * ============================================================
 *
 * A bad prompt does not fail. It answers -- plausibly, slightly wrongly, to
 * everyone -- until somebody reads a transcript and notices, which on this
 * platform's traffic could be weeks. So there is always a way back, and it is a
 * row rather than a hope that somebody kept a copy.
 */
import { getPool } from "./client.js";

/** Below this a prompt is not an instruction, it is a typo that shipped. */
export const MIN_PROMPT_CHARS = 40;

/**
 * Above this it is a document, and the model's attention is finite.
 *
 * Not a hard architectural limit -- a bigger prompt would still send. It is the
 * point at which the right home for the content is the knowledge base, which is
 * retrieved on relevance instead of prepended to every single reply including
 * the ones about opening hours.
 */
export const MAX_PROMPT_CHARS = 8000;

export interface AgentConfigView {
  id: string;
  organizationId: string;
  name: string;
  systemPrompt: string;
  model: string;
  tools: string[];
  isActive: boolean;
  /** Null means it is still exactly as onboarding left it. */
  promptUpdatedBy: string | null;
  promptUpdatedAt: string | null;
}

interface ConfigRow {
  id: string;
  organization_id: string;
  name: string;
  system_prompt: string;
  model: string;
  tools: unknown;
  is_active: boolean;
  prompt_updated_by: string | null;
  prompt_updated_at: string | null;
}

const toView = (row: ConfigRow): AgentConfigView => ({
  id: row.id,
  organizationId: row.organization_id,
  name: row.name,
  systemPrompt: row.system_prompt,
  model: row.model,
  tools: Array.isArray(row.tools) ? (row.tools as string[]) : [],
  isActive: row.is_active,
  promptUpdatedBy: row.prompt_updated_by,
  promptUpdatedAt: row.prompt_updated_at,
});

export async function getAgentConfig(organizationId: string): Promise<AgentConfigView | null> {
  const { rows } = await getPool().query<ConfigRow>(
    `select id, organization_id, name, system_prompt, model, tools, is_active,
            prompt_updated_by, prompt_updated_at
       from agent_configs
      where organization_id = $1
      order by is_active desc, created_at asc
      limit 1`,
    [organizationId]
  );
  return rows[0] ? toView(rows[0]) : null;
}

export interface PromptVersion {
  id: string;
  systemPrompt: string;
  replacedBy: string | null;
  note: string | null;
  createdAt: string;
}

export async function listPromptVersions(organizationId: string): Promise<PromptVersion[]> {
  const { rows } = await getPool().query<{
    id: string;
    system_prompt: string;
    replaced_by: string | null;
    note: string | null;
    created_at: string;
  }>(
    `select id, system_prompt, replaced_by, note, created_at
       from agent_config_versions
      where organization_id = $1
      order by created_at desc
      limit 30`,
    [organizationId]
  );
  return rows.map((row) => ({
    id: row.id,
    systemPrompt: row.system_prompt,
    replacedBy: row.replaced_by,
    note: row.note,
    createdAt: row.created_at,
  }));
}

export interface PromptRefusal {
  reason: string;
}

/**
 * Change what the agent is told to be.
 *
 * ONE TRANSACTION, and the order inside it matters: the version that is being
 * replaced is written FIRST, so a failure between the two leaves a history
 * entry with no corresponding change rather than a change with no way back.
 * Of the two ways to be wrong, that is the recoverable one.
 *
 * Returns a refusal rather than throwing for anything a person should read.
 */
export async function setSystemPrompt(input: {
  organizationId: string;
  systemPrompt: string;
  changedBy: string;
  note: string | null;
}): Promise<{ config: AgentConfigView } | PromptRefusal> {
  const next = input.systemPrompt.trim();

  if (next.length < MIN_PROMPT_CHARS) {
    return {
      reason: `That is only ${next.length} characters. An agent needs a real instruction — under ${MIN_PROMPT_CHARS} is a typo, and it would answer every customer from it.`,
    };
  }
  if (next.length > MAX_PROMPT_CHARS) {
    return {
      reason: `That is ${next.length} characters, over the ${MAX_PROMPT_CHARS} limit. Anything this long belongs in the knowledge base, which is looked up when it is relevant instead of being sent with every single reply.`,
    };
  }

  const current = await getAgentConfig(input.organizationId);
  if (!current) return { reason: "This business has no agent configured." };

  // Not an error, and not a silent no-op either: saving an unchanged prompt
  // would otherwise write a history row recording nothing, and thirty of those
  // are what make a history unreadable on the day it is needed.
  if (current.systemPrompt.trim() === next) {
    return { reason: "That is what it already says. Nothing was changed." };
  }

  const pool = getPool();
  await pool.query("begin");
  try {
    await pool.query(
      `insert into agent_config_versions
         (organization_id, agent_config_id, system_prompt, replaced_by, note)
       values ($1, $2, $3, $4, $5)`,
      [input.organizationId, current.id, current.systemPrompt, input.changedBy, input.note]
    );
    await pool.query(
      `update agent_configs
          set system_prompt = $2,
              prompt_updated_by = $3,
              prompt_updated_at = now(),
              updated_at = now()
        where id = $1`,
      [current.id, next, input.changedBy]
    );
    await pool.query("commit");
  } catch (err) {
    await pool.query("rollback").catch(() => undefined);
    throw err;
  }

  const updated = await getAgentConfig(input.organizationId);
  if (!updated) return { reason: "The prompt was changed and could not be read back." };
  return { config: updated };
}
