export interface TextChunk {
  index: number;
  content: string;
  tokenEstimate: number;
}

export interface ChunkOptions {
  /** Target maximum characters per chunk. ~1200 chars ≈ 300 tokens. */
  maxChars?: number;
  /** Characters of trailing context repeated at the start of the next chunk. */
  overlapChars?: number;
}

const DEFAULT_MAX_CHARS = 1200;
const DEFAULT_OVERLAP_CHARS = 150;

/** Rough token count. Fine for budgeting; never used for billing. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Split text into embedding-sized chunks along natural boundaries.
 *
 * Retrieval quality is decided here more than anywhere else in the pipeline: a
 * chunk that ends mid-sentence embeds a fragment of an idea and matches badly,
 * so the splitter degrades through progressively finer boundaries — paragraphs
 * first, then sentences, and only hard-slicing when a single sentence genuinely
 * exceeds the budget.
 *
 * Consecutive chunks overlap by `overlapChars` so a fact spanning a boundary is
 * still fully present in at least one chunk.
 *
 * Pure and synchronous — no model, no I/O — so chunking behaviour is unit
 * testable in isolation from embeddings.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  const maxChars = Math.max(1, options.maxChars ?? DEFAULT_MAX_CHARS);
  // Overlap must stay strictly below the chunk size, otherwise every chunk
  // would be pure repetition of the previous one and the loop could not advance.
  const overlapChars = Math.min(
    Math.max(0, options.overlapChars ?? DEFAULT_OVERLAP_CHARS),
    Math.floor(maxChars / 2)
  );

  const normalized = text.replace(/\r\n/g, "\n").replace(/ /g, " ").trim();
  if (!normalized) return [];

  const units = splitIntoUnits(normalized, maxChars);

  // Greedily pack units into chunks that stay under the budget.
  const packed: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}\n\n${unit}` : unit;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) packed.push(current);
      current = unit;
    }
  }
  if (current) packed.push(current);

  return packed
    .map((content, i) => {
      const withOverlap =
        i === 0 || overlapChars === 0
          ? content
          : `${tailContext(packed[i - 1], overlapChars)}${content}`;
      return { index: i, content: withOverlap.trim(), tokenEstimate: estimateTokens(withOverlap) };
    })
    .filter((chunk) => chunk.content.length > 0);
}

/**
 * Break text into pieces that each fit the budget, preferring the coarsest
 * boundary that works: paragraph → sentence → hard slice.
 */
function splitIntoUnits(text: string, maxChars: number): string[] {
  const units: string[] = [];

  for (const paragraph of text.split(/\n\s*\n/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;

    if (trimmed.length <= maxChars) {
      units.push(trimmed);
      continue;
    }

    // Too long as a paragraph — fall back to sentences, keeping the terminator
    // attached so the chunk still reads as prose.
    let buffer = "";
    for (const sentence of trimmed.split(/(?<=[.!?])\s+/)) {
      if (sentence.length > maxChars) {
        if (buffer) {
          units.push(buffer.trim());
          buffer = "";
        }
        // A single sentence over budget (minified text, a long table row):
        // nothing semantic left to split on, so slice it.
        for (let i = 0; i < sentence.length; i += maxChars) {
          units.push(sentence.slice(i, i + maxChars).trim());
        }
        continue;
      }

      const candidate = buffer ? `${buffer} ${sentence}` : sentence;
      if (candidate.length <= maxChars) {
        buffer = candidate;
      } else {
        if (buffer) units.push(buffer.trim());
        buffer = sentence;
      }
    }
    if (buffer.trim()) units.push(buffer.trim());
  }

  return units.filter(Boolean);
}

/**
 * Trailing context from the previous chunk, snapped forward to a word boundary
 * so the overlap never begins mid-word (which would embed a nonsense token).
 */
function tailContext(previous: string, overlapChars: number): string {
  if (overlapChars <= 0 || !previous) return "";
  const tail = previous.slice(-overlapChars);
  const boundary = tail.search(/\s/);
  const snapped = boundary === -1 ? tail : tail.slice(boundary + 1);
  return snapped ? `${snapped.trim()}\n\n` : "";
}
