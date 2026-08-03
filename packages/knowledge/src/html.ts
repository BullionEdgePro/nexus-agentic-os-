/**
 * Minimal HTML → readable text extraction.
 *
 * Deliberately dependency-free rather than pulling in a DOM parser: the goal is
 * embeddable prose, not a faithful document tree. What matters for retrieval
 * quality is that non-content is *removed* (a nav menu embedded as prose
 * pollutes every chunk of every page with the same boilerplate) and that block
 * structure survives as paragraph breaks, because the chunker splits on those.
 */

// Elements whose *contents* are never readable page text.
const DROP_ELEMENTS = ["script", "style", "noscript", "template", "svg", "iframe", "head"];

// Elements that usually wrap site chrome rather than content. Removing these is
// the single biggest quality win: without it, every chunk of every page carries
// the same nav/footer text and similarity scores flatten toward meaningless.
const DROP_REGIONS = ["nav", "header", "footer", "aside"];

// Block-level tags that should become a paragraph break, so the chunker has
// real boundaries to split on instead of one undifferentiated wall of text.
const BLOCK_ELEMENTS =
  "p|div|section|article|main|h[1-6]|li|tr|br|hr|blockquote|pre|figcaption|td|th";

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  ldquo: "“",
  rdquo: "”",
};

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeFromCodePoint(code: number): string {
  // A malformed entity must not throw mid-ingestion and fail an entire source.
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/** Extract the <title> for use as a source title when none is supplied. */
export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(stripTags(match[1])).replace(/\s+/g, " ").trim();
  return title || null;
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, "");
}

/**
 * Convert an HTML document to plain text suitable for chunking and embedding.
 */
export function htmlToText(html: string): string {
  let text = html;

  for (const tag of [...DROP_ELEMENTS, ...DROP_REGIONS]) {
    // Non-greedy, case-insensitive, tolerant of attributes and newlines.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
    // Self-closing / unclosed variants of the same tags.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, "gi"), " ");
  }

  text = text.replace(/<!--[\s\S]*?-->/g, " ");

  // Block boundaries become paragraph breaks BEFORE tags are stripped, so the
  // document's structure is preserved as something the chunker can use.
  text = text.replace(new RegExp(`<\\/?(?:${BLOCK_ELEMENTS})\\b[^>]*>`, "gi"), "\n\n");

  text = stripTags(text);
  text = decodeEntities(text);

  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t ]+/g, " ") // collapse horizontal whitespace only
    .replace(/ *\n */g, "\n") // trim each line
    .replace(/\n{3,}/g, "\n\n") // at most one blank line between blocks
    .trim();
}
