import { Hono } from "hono";
import {
  findOrganizationBySlug,
  getOrganizationSettings,
  keywordCollisions,
  updateOrganizationSettings,
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
    settings: await getOrganizationSettings(organization.id),
    // Reported, never prevented: two businesses genuinely can both do
    // attestation, and refusing the overlap would be this platform
    // overruling a fact about the world. Showing it lets whoever owns both
    // lists decide which should keep the word.
    collisions: await keywordCollisions(organization.id),
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

/**
 * What the business IS: its name, where it is, and how customers reach it.
 *
 * Operator-only for the same reason the prompt is, and one stronger. The
 * routing keywords decide WHICH BUSINESS a customer reaches on a shared
 * number, and two of the firms answering this one are competing law
 * practices. A word moved from one list to the other moves clients.
 */
agentRoute.put("/:slug/settings", async (c) => {
  const scope = scopeOf(c);
  if (scope.role !== "operator") return c.json({ error: "Not available to this account." }, 403);

  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as {
    name?: unknown;
    timezone?: unknown;
    websiteUrl?: unknown;
    whatsappDisplayNumber?: unknown;
    routingKeywords?: unknown;
  } | null;
  if (!body) return c.json({ error: "Nothing to save." }, 400);

  const before = await getOrganizationSettings(organization.id);

  const result = await updateOrganizationSettings({
    organizationId: organization.id,
    name: typeof body.name === "string" ? body.name : undefined,
    timezone: typeof body.timezone === "string" ? body.timezone : undefined,
    websiteUrl: typeof body.websiteUrl === "string" ? body.websiteUrl : undefined,
    whatsappDisplayNumber:
      typeof body.whatsappDisplayNumber === "string" ? body.whatsappDisplayNumber : undefined,
    routingKeywords: Array.isArray(body.routingKeywords)
      ? body.routingKeywords.map((k) => String(k))
      : undefined,
  });

  if ("reason" in result) return c.json({ error: result.reason }, 400);

  // The COUNTS, not the words. A keyword list is this business's commercial
  // positioning and belongs in its row rather than repeated into a log --
  // but a change in how many words route to a firm sharing a number with a
  // competitor is worth being able to date afterwards.
  logger.info(
    {
      organizationId: organization.id,
      sub: scope.sub,
      keywordsBefore: before?.routingKeywords.length ?? 0,
      keywordsAfter: result.settings.routingKeywords.length,
      timezone: result.settings.timezone,
    },
    "A business's settings were changed"
  );

  return c.json({
    settings: result.settings,
    collisions: await keywordCollisions(organization.id),
  });
});