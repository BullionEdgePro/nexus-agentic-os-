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

export interface BoilerplateOptions {
  /** Fraction of documents a line must appear in to count as chrome. */
  threshold?: number;
  /** Lines longer than this are never treated as chrome. */
  maxLineLength?: number;
  /** Below this many documents there is not enough signal to judge. */
  minDocuments?: number;
}

/**
 * Remove lines that repeat across most pages of the same site.
 *
 * Dropping nav/header/footer elements catches structural chrome, but plenty of
 * boilerplate lives outside those tags — Shopify's cart drawer ("Skip to
 * content", "View cart", "Check out") sits in the body of every page. Embedded
 * as prose it lands in the first chunk of every document, so a query about
 * checkout matches every page equally and the ranking carries no information.
 *
 * Frequency across sibling pages is the signal that identifies it without
 * hardcoding any site's markup: content is page-specific, chrome is not.
 *
 * Two guards keep it from eating real content. It needs several documents
 * before it will judge anything, and it only removes SHORT lines — a repeated
 * long sentence is more likely to be a genuine shared policy statement than
 * navigation furniture.
 */
export function stripSharedBoilerplate(
  documents: string[],
  options: BoilerplateOptions = {}
): string[] {
  const threshold = options.threshold ?? 0.8;
  const maxLineLength = options.maxLineLength ?? 80;
  const minDocuments = options.minDocuments ?? 3;

  if (documents.length < minDocuments) return documents;

  const documentCount = new Map<string, number>();
  for (const doc of documents) {
    const seen = new Set(
      doc
        .split("\n")
        .map((line) => line.trim().toLowerCase())
        .filter((line) => line.length > 0 && line.length <= maxLineLength)
    );
    for (const line of seen) documentCount.set(line, (documentCount.get(line) ?? 0) + 1);
  }

  const required = Math.ceil(documents.length * threshold);
  const chrome = new Set(
    [...documentCount.entries()].filter(([, count]) => count >= required).map(([line]) => line)
  );
  if (chrome.size === 0) return documents;

  return documents.map((doc) =>
    doc
      .split("\n")
      .filter((line) => !chrome.has(line.trim().toLowerCase()))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}

/** Extract the <title> for use as a source title when none is supplied. */
export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return null;
  const title = decodeEntities(stripTags(match[1])).replace(/\s+/g, " ").trim();
  return title || null;
}

/**
 * Remove tags, leaving a space where each one stood.
 *
 * ============================================================
 * WHY THE PATTERN IS NOT `<[^>]*>`
 * ============================================================
 *
 * It was, and a `>` inside a quoted attribute value ended the tag early — so
 * the REST of the tag became prose. Found on 2026-08-26 in SFS International's
 * indexed pages, where a Bootstrap-select widget put this into the knowledge
 * base as text a customer could be answered with:
 *
 *   1" data-actions-box="true" multiple data-select-all-text="Select All"
 *   data-none-results-text="No results matched {0}" data-container="body">
 *
 * Two chunks across the whole platform, which is why nothing noticed: it needs
 * a page whose markup happens to contain that character inside an attribute.
 * The pattern now consumes quoted runs whole, so a `>` inside one cannot
 * terminate the tag.
 *
 * ============================================================
 * WHY A SPACE RATHER THAN NOTHING
 * ============================================================
 *
 * The same page produced `ShowerRefrigeratorSaunaSwimming Pool` — an amenities
 * filter whose every option was a separate element with no whitespace between.
 * Deleting the tags welds the words together, and the result is a token no
 * embedding has ever seen and no reader can parse.
 *
 * Block elements are already turned into paragraph breaks before this runs, so
 * what is left is inline. The trade is real and small: `hel<b>lo</b>` becomes
 * "hel lo". Fusing a list of amenities into one word is the commoner accident
 * and the worse one, and the whitespace collapse downstream absorbs the rest.
 */
function stripTags(input: string): string {
  return input.replace(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, " ");
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
