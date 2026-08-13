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

/* ------------------------------------------------------------------ */
/* Placeholder text                                                    */
/* ------------------------------------------------------------------ */

/**
 * Lorem ipsum, in the forms a themed site actually ships it.
 *
 * FOUND IN PRODUCTION. SFS International's knowledge base contained four
 * chunks of placeholder text: its `/privacy/` page is an unreplaced Houzez
 * theme page whose entire body is Lorem ipsum, and `/terms-and-conditions/`
 * carries two paragraphs of it among seven real ones. The agent could retrieve
 * and cite either.
 *
 * The existing curation excludes theme demo pages BY URL — `grid-full-width`,
 * `with-parallax`, `apartments-in-new-york`. That works for pages named after
 * the theme and cannot possibly work for a page named `/privacy/`, which is
 * exactly what a real privacy policy is called. A URL cannot tell you whether
 * the words underneath it mean anything.
 *
 * Deliberately narrow. These are Latin fragments that essentially never occur
 * in genuine business copy, and no attempt is made to detect "low quality" or
 * "thin" text — that judgement belongs to a person, and a filter that guesses
 * would silently delete real content, which is far worse than keeping filler.
 */
const PLACEHOLDER_MARKERS = [
  "lorem ipsum",
  "dolor sit amet",
  "consectetur adipiscing",
  "sed do eiusmod",
  "tempor incididunt",
  "quis nostrud exercitation",
  "duis aute irure",
  "excepteur sint occaecat",
];

/** True when this text is placeholder filler rather than content. */
export function isPlaceholderText(text: string): boolean {
  const haystack = text.toLowerCase();
  const hits = PLACEHOLDER_MARKERS.filter((marker) => haystack.includes(marker));
  if (hits.length === 0) return false;

  // TWO INDEPENDENT MARKERS IS THE RULE, and it is the rule because the first
  // version was "one marker, in a chunk under 400 characters" — which flagged a
  // genuine 370-character paragraph in which a design agency said it never
  // ships lorem ipsum. Its own test caught it. Length is not evidence of
  // anything: filler comes in long pages and real copy comes in short ones.
  //
  // Real filler always trips several, because the specimen is one continuous
  // passage — "Lorem ipsum dolor sit amet, consectetur adipiscing elit" is
  // three markers in a single sentence. Writing ABOUT it names it once.
  if (hits.length >= 2) return true;

  // The one exception: a chunk that is essentially nothing but the marker. Not
  // a length heuristic on the content — a bound on how much room there is for
  // anything else to be present.
  return haystack.trim().length < 60;
}

/**
 * Drop placeholder chunks and renumber the survivors.
 *
 * PER CHUNK, not per page, and that is the whole design. `/terms-and-conditions/`
 * is two paragraphs of Lorem ipsum and seven of real terms; refusing the page
 * would throw away the seven, and keeping it whole leaves filler the agent can
 * quote back to a customer. Neither is acceptable, so the unit of judgement is
 * the chunk.
 *
 * `chunk_index` is renumbered because it is stored and ordered on. Leaving gaps
 * would work today and quietly break the first thing that assumes the indexes
 * of a source are contiguous.
 */
export function dropPlaceholderChunks(chunks: TextChunk[]): TextChunk[] {
  return chunks
    .filter((chunk) => !isPlaceholderText(chunk.content))
    .map((chunk, index) => ({ ...chunk, index }));
}
