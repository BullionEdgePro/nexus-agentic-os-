import { getPool, withServingTenant } from "@nexus/db";
import { embedQuery } from "./embed.js";

export interface KnowledgeHit {
  content: string;
  /**
   * Cosine similarity in [-1, 1] for a semantic hit; `ts_rank_cd` for a lexical
   * one. The two are NOT comparable and nothing may compare them — see
   * `searchKnowledgeLexical`, which is why `mode` exists beside this.
   */
  score: number;
  /**
   * How this passage was found. `semantic` is the real thing; `lexical` means
   * the embedding provider was unreachable and Postgres matched words.
   *
   * Carried on the hit rather than inferred by the caller from which function it
   * called, because it has to survive being put in front of the model: an
   * excerpt found by keyword needs telling apart from one found by meaning, and
   * a boolean living in the calling frame does not travel.
   */
  mode: "semantic" | "lexical";
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
 * Three rather than five, and there is no score floor at all.
 *
 * A floor was the obvious guard and the measurements refuse it: across the 18
 * probes the lowest `ts_rank_cd` on a CORRECT top hit was 0.066, and the highest
 * on a wrong one was 0.443. Any cut that removed the wrong pages would remove
 * most of the right ones with them, and a threshold picked to look principled
 * while separating nothing is worse than admitting there isn't one — it reads,
 * later, as evidence somebody checked.
 *
 * What is left is to hand over less. Five keyword matches are five chances to
 * lead the model somewhere confident and wrong; three is the same ceiling
 * `retrieval-check` judges the real ranker by.
 */
const DEFAULT_LEXICAL_LIMIT = 3;

/**
 * Who is allowed to see which chunk, written once.
 *
 * Both search paths interpolate this, and that is the entire reason it exists as
 * a constant rather than as two similar `where` clauses. A fallback that reached
 * one row more than the primary would be a tenant-isolation hole reachable only
 * during a provider outage — the least-tested moment this system has, and the
 * one where nobody would be reading the SQL.
 *
 * `$1` organization, `$2` employee. RLS is underneath this as well; the explicit
 * filter is the belt, not the braces.
 */
const VISIBILITY_SQL = `
       from knowledge_chunks c
       join knowledge_sources s on s.id = c.source_id
       where c.organization_id = $1
         and s.status = 'indexed'
         -- Tenant-wide chunks (employee_id is null) are visible to everyone;
         -- an employee's own knowledge is visible only to them.
         and (c.employee_id is null or c.employee_id = $2::uuid)`;

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
/**
 * FIFTH INSTANCE OF THE SHARED-NUMBER TRAP, and the one that would have made the
 * fourth fix look like a regression.
 *
 * `knowledge_chunks` is under RLS. Every reply on this number runs inside a
 * transaction scoped to the OWNER, and the agent tool passes the SERVING
 * business's id — so this read matched nothing for four of the five businesses.
 * Measured 2026-08-18: juris-prime's 91 chunks, read as Zipicka, come back as 0.
 *
 * It was invisible until this morning because a worse bug hid it. Routed
 * customers got no reply at all (no agent config, same cause), so nobody ever
 * reached the retrieval. Fixing that alone would have shipped a reply that
 * arrives and says "I'll check with a colleague" to every question — grounded in
 * nothing, exactly as the tool description instructs when nothing comes back.
 *
 * Scoped HERE rather than at the two call sites in the tool, for the reason the
 * agent-config fix gives: a rule every caller has to remember is a rule the
 * fourth caller will not. `withServingTenant` is a safe drop-in — no ambient
 * transaction degrades to `withTenant`, the same organization is a no-op, and an
 * unrelated business throws rather than widening, which is the case that should
 * never be silent.
 */
export async function searchKnowledge(input: SearchKnowledgeInput): Promise<KnowledgeHit[]> {
  return withServingTenant(input.organizationId, () => searchKnowledgeScoped(input));
}

async function searchKnowledgeScoped(input: SearchKnowledgeInput): Promise<KnowledgeHit[]> {
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
              nexus_dot(c.embedding, $3::real[]) as score
       ${VISIBILITY_SQL}
         and c.embedding is not null
     ) ranked
     where score is not null and score >= $4
     order by score desc
     limit $5`,
    [input.organizationId, input.employeeId ?? null, queryVector, minScore, limit]
  );

  return rows.map((row) => ({
    content: row.content,
    score: Number(row.score),
    mode: "semantic" as const,
    sourceTitle: row.title,
    sourceUri: row.uri,
    chunkIndex: row.chunk_index,
    lastIndexedAt: row.last_indexed_at,
  }));
}

/**
 * The same knowledge base, read by words instead of by meaning.
 *
 * ONLY EVER CALLED AFTER `searchKnowledge` HAS THROWN. Nothing here is an
 * improvement on semantic search and it must never run beside it: a semantic
 * miss is a deliberate refusal, and re-asking a weaker matcher would turn "we
 * have nothing on that" into "here is a page that shares a noun with your
 * question", which is the exact failure `DEFAULT_MIN_SCORE` was set to prevent.
 *
 * WHAT IT IS WORTH, MEASURED. Run over `retrieval-check`'s 18 probes — the same
 * realistic customer questions, against the same live corpus — semantic search
 * finds the right page in the top 3 all 18 times and this finds it **13**. That
 * ratio is the honest case for the feature and the honest case against trusting
 * it: during an outage the alternative is not semantic search, it is zero, every
 * customer told a colleague will confirm while the answer sits in the table in
 * plain text. Re-measure with `retrieval-check --lexical` rather than believing
 * this paragraph.
 *
 * WHERE THE OTHER FIVE GO WRONG MATTERS MORE THAN THAT THEY DO. "what happens to
 * my property when I die, do I need a will?" returns real-estate law, because
 * "property" is a word two different areas of law share. That is not a near
 * miss; it is a confident, plausible, wrong page, and a model handed it will
 * write a grounded-sounding answer about the wrong subject. No rank floor
 * separates it — it scored 0.125 while a correct hit scored 0.066. So the guard
 * is not arithmetic: the caller labels these as keyword matches and tells the
 * model to use them only where they plainly answer the question. Judging
 * relevance is the one part of this the model is better at than the matcher.
 *
 * TERMS ARE OR-ed, NOT AND-ed. `websearch_to_tsquery` builds a conjunction, and
 * on real questions that is close to useless: only 8 of the 18 probes returned
 * any row at all, because every content word had to appear in one chunk. The
 * disjunction is built inside SQL from `to_tsvector`'s own lexemes with each one
 * quoted, so no part of a customer's message is ever concatenated into tsquery
 * syntax.
 */
export async function searchKnowledgeLexical(
  input: SearchKnowledgeInput
): Promise<KnowledgeHit[]> {
  // Same scoping as the semantic path, and it matters more here rather than
  // less: this one only ever runs during a provider outage, which is the
  // moment nobody is reading the SQL.
  return withServingTenant(input.organizationId, () => searchKnowledgeLexicalScoped(input));
}

async function searchKnowledgeLexicalScoped(
  input: SearchKnowledgeInput
): Promise<KnowledgeHit[]> {
  const limit = input.limit ?? DEFAULT_LEXICAL_LIMIT;

  const { rows } = await getPool().query<{
    content: string;
    score: number;
    title: string;
    uri: string | null;
    chunk_index: number;
    last_indexed_at: string | null;
  }>(
    `with q as (
       select to_tsquery('english',
                array_to_string(
                  array(select quote_literal(lexeme)
                          from unnest(tsvector_to_array(to_tsvector('english', $3::text))) lexeme),
                  ' | ')) as tsq
     )
     select c.content,
            s.title,
            s.uri,
            c.chunk_index,
            s.last_indexed_at,
            ts_rank_cd(to_tsvector('english', c.content), (select tsq from q), 1) as score
     ${VISIBILITY_SQL}
       and to_tsvector('english', c.content) @@ (select tsq from q)
     order by score desc
     limit $4`,
    [input.organizationId, input.employeeId ?? null, input.query, limit]
  );

  return rows.map((row) => ({
    content: row.content,
    score: Number(row.score),
    mode: "lexical" as const,
    sourceTitle: row.title,
    sourceUri: row.uri,
    chunkIndex: row.chunk_index,
    lastIndexedAt: row.last_indexed_at,
  }));
}
