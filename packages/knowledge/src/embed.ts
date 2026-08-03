import { GoogleGenAI } from "@google/genai";

/**
 * Embedding model. Kept configurable because a model being silently retired is
 * not hypothetical on this platform — `gemini-2.5-flash` was closed to new API
 * keys while still being advertised by models.list, and every reply degraded to
 * the fallback message before anyone noticed. Same failure mode applies here.
 */
export const EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

// Conservative batch size. The free tier's request-per-minute ceiling is the
// real constraint on this pipeline, not payload size — one request carrying 32
// chunks costs a single unit of quota where 32 requests would exhaust it.
const BATCH_SIZE = 32;

let client: GoogleGenAI | undefined;
function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

/**
 * Scale a vector to unit length.
 *
 * This is the load-bearing step for the whole retrieval design: with every
 * stored vector and every query vector normalized, cosine similarity reduces to
 * a plain dot product, which is why the database needs no pgvector extension
 * (see migration 003). A zero vector has no direction to preserve, so it is
 * returned unchanged rather than producing NaNs downstream.
 */
export function normalize(vector: number[]): number[] {
  let sumOfSquares = 0;
  for (const value of vector) sumOfSquares += value * value;
  const norm = Math.sqrt(sumOfSquares);
  if (!norm || !Number.isFinite(norm)) return vector;
  return vector.map((value) => value / norm);
}

/**
 * Embed texts, returning L2-normalized vectors in the same order as the input.
 *
 * Throws on API failure rather than returning partial results: a half-embedded
 * source written to the database would be silently unsearchable for the missing
 * part, which is exactly the kind of quiet degradation this codebase keeps
 * getting bitten by. Callers mark the source `failed` and retry.
 */
export async function embedTexts(texts: string[], model = EMBEDDING_MODEL): Promise<number[][]> {
  if (texts.length === 0) return [];

  const ai = getClient();
  const out: number[][] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    const batch = texts.slice(start, start + BATCH_SIZE);
    const response = await ai.models.embedContent({ model, contents: batch });
    const embeddings = response.embeddings ?? [];

    if (embeddings.length !== batch.length) {
      throw new Error(
        `Embedding count mismatch: asked for ${batch.length}, received ${embeddings.length}`
      );
    }

    for (const embedding of embeddings) {
      const values = embedding.values;
      if (!values || values.length === 0) {
        throw new Error("Embedding API returned an empty vector");
      }
      out.push(normalize(values));
    }
  }

  return out;
}

/** Embed a single query string. Same normalization as stored vectors. */
export async function embedQuery(query: string, model = EMBEDDING_MODEL): Promise<number[]> {
  const [vector] = await embedTexts([query], model);
  if (!vector) throw new Error("Failed to embed query");
  return vector;
}
