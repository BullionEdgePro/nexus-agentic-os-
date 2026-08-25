import { Hono } from "hono";
import {
  findOrganizationBySlug,
  getAgentConfig,
  listPromptVersions,
  setSystemPrompt,
  MAX_PROMPT_CHARS,
  MIN_PROMPT_CHARS,
} from "@nexus/db";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * What the agent is told to be.
 *
 * ============================================================
 * OPERATOR ONLY, AND THIS ONE IS NOT A JUDGEMENT CALL
 * ============================================================
 *
 * Most screens on this deck are reachable by an employee, on the reasoning that
 * a business's own operational information is not management information about
 * its staff. This is different in kind. The system prompt is the standing
 * instruction under every reply this platform sends to every customer of this
 * business, and an edit to it takes effect on the next message with no review
 * and no approval step anywhere.
 *
 * That is a change to what the company SAYS. It belongs with whoever answers
 * for the company, not with everyone who can sign in.
 */
export const agentRoute = new Hono();

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

agentRoute.get("/:slug/agent", async (c) => {
  const scope = scopeOf(c);
  if (scope.role !== "operator") return c.json({ error: "Not available to this account." }, 403);

  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const config = await getAgentConfig(organization.id);
  if (!config) return c.json({ error: "This business has no agent configured." }, 404);

  return c.json({
    config,
    history: await listPromptVersions(organization.id),
    // Sent rather than duplicated in the browser, so the counter on the screen
    // and the rule that refuses cannot disagree about what is too long.
    limits: { min: MIN_PROMPT_CHARS, max: MAX_PROMPT_CHARS },
  });
});

agentRoute.put("/:slug/agent/prompt", async (c) => {
  const scope = scopeOf(c);
  if (scope.role !== "operator") return c.json({ error: "Not available to this account." }, 403);

  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    systemPrompt?: unknown;
    note?: unknown;
  } | null;
  if (typeof body?.systemPrompt !== "string") {
    return c.json({ error: "Nothing to save." }, 400);
  }

  const result = await setSystemPrompt({
    organizationId: organization.id,
    systemPrompt: body.systemPrompt,
    // Always a person. This changes what a company says to its customers.
    changedBy: scope.sub,
    note: typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 300) : null,
  });

  if ("reason" in result) return c.json({ error: result.reason }, 400);

  // Logged as the significant act it is, with the LENGTHS rather than the text.
  // The prompt is in the database and in its own history table; repeating it
  // into a log adds nothing and puts a business's own wording somewhere it did
  // not choose to put it.
  logger.info(
    {
      organizationId: organization.id,
      sub: scope.sub,
      characters: result.config.systemPrompt.length,
    },
    "The system prompt was changed — every reply after this one is generated from it"
  );

  return c.json({ config: result.config, history: await listPromptVersions(organization.id) });
});
