import { getPool } from "@nexus/db";
import { embedQuery } from "./embed.js";

export interface KnowledgeHit {
  content: string;
  /** Cosine similarity in [-1, 1]. Higher is closer. */
  score: number;
  sourceTitle: string;
  sourceUri: string | null;
  chunkIndex: number;
  lastIndexedAt: string | null;
}

export interface SearchKnowledgeInput {
  organizationId: string;
  /** Restricts results to tenant-wide knowledge plus this employee's own. */
  employeeId?: string | null;
  query: string;
  limit?: number;
  /**
   * Similarity floor. Below this a "match" is noise, and feeding noise to the
   * model as though it were grounding is how a RAG system starts hallucinating
   * with citations attached — worse than returning nothing.
   */
  minScore?: number;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.55;

/**
 * Semantic search over a tenant's knowledge base, returning chunks with their
 * source attribution.
 *
 * Every result carries its source title, URI, and index date so the agent can
 * cite what it used and a human can audit it. An answer that cannot point at
 * where it came from is indistinguishable from one the model invented.
 *
 * Tenant isolation is enforced on `knowledge_chunks.organization_id`, which is
 * denormalized onto the chunk precisely so this filter never depends on a join
 * being written correctly.
 */
export async function searchKnowledge(input: SearchKnowledgeInput): Promise<KnowledgeHit[]> {
  const limit = input.limit ?? DEFAULT_LIMIT;
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE;

  const queryVector = await embedQuery(input.query);

  const { rows } = await getPool().query<{
    content: string;
    score: number;
    title: string;
    uri: string | null;
    chunk_index: number;
    last_indexed_at: string | null;
  }>(
    `select * from (
       select c.content,
              s.title,
              s.uri,
              c.chunk_index,
              s.last_indexed_at,
              nexus_dot(c.embedding, $2::real[]) as score
       from knowledge_chunks c
       join knowledge_sources s on s.id = c.source_id
       where c.organization_id = $1
         and c.embedding is not null
         and s.status = 'indexed'
         -- Tenant-wide chunks (employee_id is null) are visible to everyone;
         -- an employee's own knowledge is visible only to them.
         and (c.employee_id is null or c.employee_id = $3::uuid)
     ) ranked
     where score is not null and score >= $4
     order by score desc
     limit $5`,
    [input.organizationId, queryVector, input.employeeId ?? null, minScore, limit]
  );

  return rows.map((row) => ({
    content: row.content,
    score: Number(row.score),
    sourceTitle: row.title,
    sourceUri: row.uri,
    chunkIndex: row.chunk_index,
    lastIndexedAt: row.last_indexed_at,
  }));
}
