import { Hono } from "hono";
import { findOrganizationBySlug } from "@nexus/db";
import {
  listKnowledgeSources,
  deleteKnowledgeSource,
  ingestUrlSource,
  ingestTextSource,
  UnsafeUrlError,
} from "@nexus/knowledge";
import { logger } from "../lib/logger.js";

/**
 * Knowledge base management.
 *
 * Until now sources could only be added by running node inside the worker
 * container, which meant the people who own the content could not maintain it.
 *
 * Mounted under /api/*, so `requireAuth` already covers every route here — that
 * matters more than usual: these endpoints fetch arbitrary URLs and write into
 * what the agent will later quote to customers, so an unauthenticated caller
 * could poison a tenant's answers.
 */
export const knowledgeRoute = new Hono();

knowledgeRoute.get("/:slug/knowledge", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const sources = await listKnowledgeSources(organization.id);
  return c.json({ sources });
});

/**
 * Add a source, indexing it inline.
 *
 * Deliberately synchronous rather than queued: this is a low-frequency operator
 * action, and an immediate "indexed 6 chunks" is far more useful than a job id
 * the caller then has to poll. A page that is slow to fetch is bounded by the
 * fetcher's own timeout, and a failure returns the reason rather than leaving a
 * source stuck in `pending` with nobody watching.
 */
knowledgeRoute.post("/:slug/knowledge", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  let body: { url?: string; title?: string; content?: string; employeeId?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const url = body.url?.trim();
  const content = body.content?.trim();

  if (!url && !content) {
    return c.json({ error: "Provide either a url or content to index." }, 400);
  }
  if (content && !body.title?.trim()) {
    return c.json({ error: "A title is required when indexing raw content." }, 400);
  }

  try {
    const result = url
      ? await ingestUrlSource({
          organizationId: organization.id,
          employeeId: body.employeeId ?? null,
          url,
          title: body.title?.trim() || undefined,
        })
      : await ingestTextSource({
          organizationId: organization.id,
          employeeId: body.employeeId ?? null,
          title: body.title!.trim(),
          content: content!,
          kind: "text",
        });

    return c.json({
      sourceId: result.sourceId,
      chunks: result.chunks,
      // `skipped` is not a failure — the content hash was unchanged, so no
      // re-embedding was needed. Surfaced so the caller can say so plainly
      // rather than reporting "0 chunks" and looking broken.
      unchanged: result.skipped,
    });
  } catch (err) {
    // A blocked URL is the caller's mistake, not a server fault — 400 with the
    // reason, so an operator who pastes an internal address learns why.
    if (err instanceof UnsafeUrlError) {
      return c.json({ error: err.message }, 400);
    }
    logger.error({ err, url }, "Knowledge ingestion failed");
    return c.json(
      { error: err instanceof Error ? err.message : "Ingestion failed" },
      502
    );
  }
});

knowledgeRoute.delete("/:slug/knowledge/:id", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const removed = await deleteKnowledgeSource(organization.id, c.req.param("id"));
  if (!removed) return c.json({ error: "Source not found" }, 404);
  return c.json({ ok: true });
});
