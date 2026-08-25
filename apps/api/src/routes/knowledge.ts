import { Hono } from "hono";
import { findOrganizationBySlug } from "@nexus/db";
import {
  listKnowledgeSources,
  deleteKnowledgeSource,
  ingestUrlSource,
  ingestTextSource,
  extractFile,
  formatOf,
  MAX_FILE_BYTES,
  READABLE_FORMATS,
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

/**
 * Index a document somebody uploads.
 *
 * ============================================================
 * WHY THIS IS A SEPARATE ROUTE FROM THE ONE ABOVE
 * ============================================================
 *
 * The JSON route takes a url or a body of text; this one takes bytes, and the
 * two cannot share a handler because the request is parsed differently before
 * anything else can happen. Folding them together would mean reading the body
 * twice or guessing at the content type, and guessing is how a truncated
 * upload becomes a knowledge source containing half a document.
 *
 * ============================================================
 * WHAT IT REFUSES, AND WHY REFUSING IS THE POINT
 * ============================================================
 *
 * A scanned PDF is a picture of words. A parser handed one returns an empty
 * string rather than an error, so without a floor this would answer "ok, 0
 * chunks", list the source beside the working ones, and leave the agent saying
 * "I'll check with a colleague" to every question that document answers. So an
 * unreadable file is a 400 with a sentence naming the likely cause -- see
 * `extractFile`, which holds that rule for every caller rather than here.
 */
knowledgeRoute.post("/:slug/knowledge/file", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  let form: Record<string, unknown>;
  try {
    form = await c.req.parseBody();
  } catch {
    return c.json({ error: "That upload could not be read." }, 400);
  }

  const file = form.file;
  if (!(file instanceof File)) {
    return c.json({ error: "Attach a file to index." }, 400);
  }

  // Checked before the bytes are pulled into memory as well as inside
  // extractFile: the second is the rule, this one keeps a 500MB upload from
  // being buffered just to be told no.
  if (file.size > MAX_FILE_BYTES) {
    const mb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
    return c.json({ error: `That file is larger than ${mb}MB.` }, 400);
  }
  if (!formatOf(file.name)) {
    return c.json({ error: `"${file.name}" is not a format this can read. Upload ${READABLE_FORMATS}.` }, 400);
  }

  const extracted = await extractFile(file.name, new Uint8Array(await file.arrayBuffer()));
  if ("reason" in extracted) return c.json({ error: extracted.reason }, 400);

  const titleField = form.title;
  const title = typeof titleField === "string" && titleField.trim() ? titleField.trim() : file.name;
  const employeeField = form.employeeId;

  try {
    const result = await ingestTextSource({
      organizationId: organization.id,
      employeeId: typeof employeeField === "string" && employeeField ? employeeField : null,
      title,
      content: extracted.text,
      // 'file' has been allowed by the schema since migration 003 and has never
      // had a writer. The deck can now tell an uploaded document apart from
      // something typed in, which matters when a source needs re-checking and
      // nobody remembers where it came from.
      kind: "file",
    });

    logger.info(
      { organizationId: organization.id, format: extracted.format, chunks: result.chunks, characters: extracted.text.length },
      "A document was indexed"
    );

    return c.json({
      sourceId: result.sourceId,
      chunks: result.chunks,
      unchanged: result.skipped,
      format: extracted.format,
      characters: extracted.text.length,
    });
  } catch (err) {
    logger.error({ err, filename: file.name }, "Document ingestion failed");
    return c.json({ error: err instanceof Error ? err.message : "Ingestion failed" }, 502);
  }
});

knowledgeRoute.delete("/:slug/knowledge/:id", async (c) => {
  const organization = await findOrganizationBySlug(c.req.param("slug"));
  if (!organization) return c.json({ error: "Organization not found" }, 404);

  const removed = await deleteKnowledgeSource(organization.id, c.req.param("id"));
  if (!removed) return c.json({ error: "Source not found" }, 404);
  return c.json({ ok: true });
});
