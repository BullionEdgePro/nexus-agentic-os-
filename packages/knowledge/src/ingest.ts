import { createHash } from "node:crypto";
import { getPool, withTenant } from "@nexus/db";
import { chunkText, dropPlaceholderChunks } from "./chunk.js";
import { embedTexts, EMBEDDING_MODEL } from "./embed.js";
import { fetchDocument, type FetchedDocument } from "./fetch-url.js";
import { stripSharedBoilerplate } from "./html.js";

export type SourceKind = "text" | "url" | "file" | "faq" | "sop";

export interface IngestSourceInput {
  organizationId: string;
  employeeId?: string | null;
  title: string;
  content: string;
  kind?: SourceKind;
  uri?: string | null;
}

export interface IngestResult {
  sourceId: string;
  chunks: number;
  /** True when the content hash was unchanged and no re-embedding happened. */
  skipped: boolean;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Ingest several pages of the same site together.
 *
 * Ingesting as a set rather than one at a time is what makes cross-page
 * boilerplate removal possible: chrome is only identifiable by comparing
 * sibling pages, so a page ingested alone keeps its nav furniture forever.
 * This is the entry point a crawler should use.
 *
 * A page that fails to fetch does not abort the batch — the rest still index,
 * and the failure is returned so the caller can report it.
 */
export async function ingestUrlSet(input: {
  organizationId: string;
  employeeId?: string | null;
  urls: string[];
}): Promise<Array<IngestResult & { url: string } | { url: string; error: string }>> {
  const fetched = await Promise.all(
    input.urls.map(async (url) => {
      try {
        return { url, doc: await fetchDocument(url) };
      } catch (err) {
        return { url, error: err instanceof Error ? err.message : String(err) };
      }
    })
  );

  const ok = fetched.filter((f): f is { url: string; doc: FetchedDocument } => "doc" in f);
  const cleaned = stripSharedBoilerplate(ok.map((f) => f.doc.text));

  const results: Array<IngestResult & { url: string } | { url: string; error: string }> = [];
  for (const failure of fetched.filter((f): f is { url: string; error: string } => "error" in f)) {
    results.push(failure);
  }

  for (const [i, entry] of ok.entries()) {
    try {
      const result = await ingestTextSource({
        organizationId: input.organizationId,
        employeeId: input.employeeId ?? null,
        title: entry.doc.title ?? new URL(entry.doc.url).hostname,
        content: cleaned[i],
        kind: "url",
        uri: entry.doc.url,
      });
      results.push({ ...result, url: entry.url });
    } catch (err) {
      results.push({ url: entry.url, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return results;
}

/**
 * Ingest a public web page as a knowledge source.
 *
 * Thin wrapper over ingestTextSource: fetching and text extraction are the only
 * new parts, and everything downstream — hash-based idempotency, chunking,
 * embedding, transactional replacement — is shared with every other source
 * type. Re-running this on an unchanged page costs one fetch and one hash
 * comparison, which is what makes scheduled re-crawls affordable on a
 * rate-limited free tier.
 */
export async function ingestUrlSource(input: {
  organizationId: string;
  employeeId?: string | null;
  url: string;
  /** Overrides the page's own <title>. */
  title?: string;
}): Promise<IngestResult> {
  const doc = await fetchDocument(input.url);
  return ingestTextSource({
    organizationId: input.organizationId,
    employeeId: input.employeeId ?? null,
    title: input.title ?? doc.title ?? new URL(doc.url).hostname,
    content: doc.text,
    kind: "url",
    uri: doc.url,
  });
}

/**
 * Ingest text into a tenant's knowledge base: chunk, embed, and index it.
 *
 * Idempotent by content hash. Re-ingesting unchanged content is a no-op, which
 * is what makes a scheduled re-crawl affordable — the cost of checking a source
 * that has not changed is one hash comparison rather than a full re-embed. On
 * the free tier, where quota is the binding constraint, that difference decides
 * whether periodic re-indexing is viable at all.
 *
 * Chunk replacement runs in a transaction: a source is never left half-indexed,
 * because a partially-replaced source would silently answer from a mix of old
 * and new content with no indication anything was wrong.
 */
export async function ingestTextSource(input: IngestSourceInput): Promise<IngestResult> {
  const pool = getPool();
  const contentHash = hashContent(input.content);
  const kind = input.kind ?? "text";

  // Identify an existing source by URI when there is one, falling back to
  // title only for inline text that has no origin.
  //
  // Matching on title as well would break re-indexing: a page whose <title>
  // changes between crawls (a promo banner, a renamed section) would fail to
  // match its own row and silently create a duplicate source, so the knowledge
  // base would then hold and cite BOTH the old and new copies of that page.
  const { rows: existing } = input.uri
    ? await pool.query<{ id: string; content_hash: string | null }>(
        `select id, content_hash from knowledge_sources
         where organization_id = $1 and uri = $2
           and employee_id is not distinct from $3`,
        [input.organizationId, input.uri, input.employeeId ?? null]
      )
    : await pool.query<{ id: string; content_hash: string | null }>(
        `select id, content_hash from knowledge_sources
         where organization_id = $1 and title = $2 and uri is null
           and employee_id is not distinct from $3`,
        [input.organizationId, input.title, input.employeeId ?? null]
      );

  // A KNOWN LIMIT OF EVERY CONTENT FILTER BELOW THIS LINE.
  //
  // The hash check short-circuits before chunking, so a page whose content has
  // not changed keeps whatever chunks it already has — including ones a filter
  // added later would now remove. SFS's /terms-and-conditions/ was exactly
  // this: it reported "already current" on the run that introduced
  // `dropPlaceholderChunks`, and its two Lorem ipsum passages survived until
  // its `content_hash` was cleared by hand to force a re-chunk.
  //
  // Deliberately not solved by re-chunking on every check — that would spend an
  // embedding call per source per sweep to catch a case that arises only when a
  // filter changes. The remedy is a one-line update when one does:
  //
  //   update knowledge_sources set content_hash = null where <affected>;
  if (existing[0] && existing[0].content_hash === contentHash) {
    await pool.query(`update knowledge_sources set last_checked_at = now() where id = $1`, [
      existing[0].id,
    ]);
    return { sourceId: existing[0].id, chunks: 0, skipped: true };
  }

  const sourceId = existing[0]?.id
    ? await updateSource(existing[0].id, contentHash, input.title)
    : await insertSource(input, kind, contentHash);

  try {
    // Placeholder filler is removed before embedding, not after. Embedding it
    // would spend a model call on text that must not be retrievable, and the
    // vector would sit in the same table as real content waiting for a query it
    // happens to match.
    const split = chunkText(input.content);
    const chunks = dropPlaceholderChunks(split);

    // A page whose every chunk was filler is REPORTED, not quietly stored as
    // "indexed, 0 passages". SFS's /privacy/ is exactly this: an unreplaced
    // Houzez theme page under a URL a real privacy policy would use. Marked
    // indexed it would sit on the knowledge screen looking healthy, and the
    // operator sweep would see a source that had not failed. Marked failed, it
    // says what is wrong and where — and `broken-knowledge` surfaces it without
    // anybody counting rows.
    if (split.length > 0 && chunks.length === 0) {
      const message = "Every passage on this page is placeholder text (Lorem ipsum), so nothing was indexed. The page most likely still carries its website theme's sample content.";
      await getPool().query(
        `update knowledge_sources set status = 'failed', error = $2, last_checked_at = now()
         where id = $1`,
        [sourceId, message]
      );
      return { sourceId, chunks: 0, skipped: false };
    }

    if (chunks.length === 0) {
      await markIndexed(sourceId);
      return { sourceId, chunks: 0, skipped: false };
    }

    // Embed BEFORE opening the transaction. Embedding is the slow, failure-prone
    // network step; holding a database transaction open across it would pin a
    // connection for seconds and roll back on any API hiccup.
    const vectors = await embedTexts(chunks.map((c) => c.content));

    // Scoped and transactional in one step. The embedding call above stays
    // outside it deliberately — holding a connection open across a slow network
    // call would pin it for seconds and roll back on any API hiccup — so the
    // context begins here, once there is only database work left to do.
    await withTenant(input.organizationId, async () => {
      const db = getPool();
      await db.query(`delete from knowledge_chunks where source_id = $1`, [sourceId]);

      for (const [i, chunk] of chunks.entries()) {
        await db.query(
          `insert into knowledge_chunks
             (source_id, organization_id, employee_id, chunk_index, content,
              token_estimate, embedding, embedding_model)
           values ($1, $2, $3, $4, $5, $6, $7::real[], $8)`,
          [
            sourceId,
            input.organizationId,
            input.employeeId ?? null,
            chunk.index,
            chunk.content,
            chunk.tokenEstimate,
            vectors[i],
            EMBEDDING_MODEL,
          ]
        );
      }

      await db.query(
        `update knowledge_sources
         set status = 'indexed', last_indexed_at = now(), last_checked_at = now(), error = null
         where id = $1`,
        [sourceId]
      );
    });

    return { sourceId, chunks: chunks.length, skipped: false };
  } catch (err) {
    // Record why indexing failed on the row itself. A source stuck in 'failed'
    // with its error is diagnosable; one that silently returns nothing at query
    // time is not.
    await pool.query(
      `update knowledge_sources set status = 'failed', error = $2, last_checked_at = now()
       where id = $1`,
      [sourceId, err instanceof Error ? err.message : String(err)]
    );
    throw err;
  }
}

async function insertSource(
  input: IngestSourceInput,
  kind: SourceKind,
  contentHash: string
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into knowledge_sources
       (organization_id, employee_id, kind, uri, title, content_hash, status)
     values ($1, $2, $3, $4, $5, $6, 'pending')
     returning id`,
    [
      input.organizationId,
      input.employeeId ?? null,
      kind,
      input.uri ?? null,
      input.title,
      contentHash,
    ]
  );
  return rows[0].id;
}

async function updateSource(
  sourceId: string,
  contentHash: string,
  title: string
): Promise<string> {
  // Title is refreshed too — the row is identified by URI, so a retitled page
  // should show its current name rather than the one it had at first crawl.
  await getPool().query(
    `update knowledge_sources
     set content_hash = $2, title = $3, version = version + 1, status = 'pending', error = null
     where id = $1`,
    [sourceId, contentHash, title]
  );
  return sourceId;
}

async function markIndexed(sourceId: string): Promise<void> {
  await getPool().query(
    `update knowledge_sources
     set status = 'indexed', last_indexed_at = now(), last_checked_at = now(), error = null
     where id = $1`,
    [sourceId]
  );
}
