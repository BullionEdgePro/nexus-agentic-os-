import { inflateSync } from "node:zlib";

/**
 * The words out of a PDF, without a renderer or a new dependency.
 *
 * ============================================================
 * WHY NOT SEND THE PDF TO THE MODEL
 * ============================================================
 *
 * Anthropic reads PDFs directly, and that is the better answer — but the SDK
 * pinned here is 0.32.1, which predates document blocks entirely: there is no
 * `DocumentBlockParam` in it, beta or otherwise. Upgrading the package that
 * every agent call on this platform runs through, in order to add a file picker
 * to a help panel, is the wrong trade. When the SDK is next upgraded for its
 * own reasons, this becomes deletable and the PDF should be passed straight
 * through.
 *
 * ============================================================
 * IT DISTINGUISHES "EMPTY" FROM "A PICTURE OF WORDS"
 * ============================================================
 *
 * Half the PDFs a person will attach are scans — a licence, a receipt, an
 * invoice photographed and wrapped. Those have no text layer at all, and the
 * failure to catch that is the interesting one: an extractor returns "" and the
 * assistant confidently discusses an empty document.
 *
 * So a scan is reported as a scan, with the thing that does work said in the
 * same breath. A photograph of the page IS readable — as an image.
 */

const BACKSLASH = 92;

/** Every decompressed stream in the file, as latin-1 text. */
function streams(raw: Buffer): string[] {
  const out: string[] = [];
  const marker = Buffer.from("stream");
  let at = 0;

  while (at < raw.length) {
    const start = raw.indexOf(marker, at);
    if (start === -1) break;
    let from = start + marker.length;
    if (raw[from] === 0x0d) from += 1;
    if (raw[from] === 0x0a) from += 1;

    const end = raw.indexOf(Buffer.from("endstream"), from);
    if (end === -1) break;

    const body = raw.subarray(from, end);
    try {
      out.push(inflateSync(body).toString("latin1"));
    } catch {
      // Not deflate — an image, or already plain. Kept as-is: an uncompressed
      // content stream is still readable and dropping it loses real text.
      out.push(body.toString("latin1"));
    }
    at = end + 1;
  }
  return out;
}

/**
 * code -> character, from every ToUnicode CMap in the document.
 *
 * One table for the whole file rather than one per font. That is wrong in
 * principle where two fonts reuse a code for different glyphs, and right in
 * practice for reading a document a person has attached — the output is for a
 * model to read, not to round-trip.
 */
function unicodeMap(chunks: string[]): Map<number, string> {
  const table = new Map<number, string>();

  for (const chunk of chunks) {
    if (!chunk.includes("beginbfchar") && !chunk.includes("beginbfrange")) continue;

    for (const block of chunk.match(/beginbfchar([\s\S]*?)endbfchar/g) ?? []) {
      for (const pair of block.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) ?? []) {
        const [src, dst] = pair.match(/<([0-9A-Fa-f]+)>/g)?.map((h) => h.slice(1, -1)) ?? [];
        if (!src || !dst) continue;
        let text = "";
        for (let i = 0; i < dst.length; i += 4) text += String.fromCharCode(parseInt(dst.slice(i, i + 4), 16));
        table.set(parseInt(src, 16), text);
      }
    }

    for (const block of chunk.match(/beginbfrange([\s\S]*?)endbfrange/g) ?? []) {
      const triples = block.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g) ?? [];
      for (const triple of triples) {
        const parts = triple.match(/<([0-9A-Fa-f]+)>/g)?.map((h) => h.slice(1, -1)) ?? [];
        if (parts.length < 3) continue;
        const lo = parseInt(parts[0], 16);
        const hi = parseInt(parts[1], 16);
        const base = parseInt(parts[2], 16);
        for (let code = lo, k = 0; code <= hi && k < 65_536; code += 1, k += 1) {
          table.set(code, String.fromCharCode(base + k));
        }
      }
    }
  }
  return table;
}

/** The parenthesised string operands, honouring escapes and nesting. */
function parenthesised(blob: string): string[] {
  const out: string[] = [];
  let i = 0;

  while (i < blob.length) {
    if (blob[i] !== "(") {
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    let buf = "";
    while (j < blob.length && depth > 0) {
      const code = blob.charCodeAt(j);
      if (code === BACKSLASH && j + 1 < blob.length) {
        buf += blob[j + 1];
        j += 2;
        continue;
      }
      if (blob[j] === "(") depth += 1;
      else if (blob[j] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      buf += blob[j];
      j += 1;
    }
    out.push(buf);
    i = j + 1;
  }
  return out;
}

export type PdfText =
  | { ok: true; text: string }
  | { ok: false; reason: "scanned" | "unreadable" };

/**
 * Read a PDF's text layer.
 *
 * Returns `scanned` rather than an empty string when there is nothing to read,
 * so the caller can say the true thing instead of discussing a blank document.
 */
export function pdfToText(pdf: Buffer): PdfText {
  let chunks: string[];
  try {
    chunks = streams(pdf);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (chunks.length === 0) return { ok: false, reason: "unreadable" };

  const table = unicodeMap(chunks);
  const pieces: string[] = [];

  for (const chunk of chunks) {
    if (!chunk.includes("Tj") && !chunk.includes("TJ")) continue;

    // CID-encoded text: hex strings mapped through the font's own table.
    if (table.size > 0) {
      for (const hex of chunk.match(/<([0-9A-Fa-f\s]+)>/g) ?? []) {
        const digits = hex.slice(1, -1).replace(/\s/g, "");
        if (digits.length === 0 || digits.length % 4 !== 0) continue;
        let word = "";
        for (let i = 0; i < digits.length; i += 4) {
          word += table.get(parseInt(digits.slice(i, i + 4), 16)) ?? "";
        }
        if (word.trim()) pieces.push(word);
      }
    }

    // Plain encoded text.
    for (const literal of parenthesised(chunk)) {
      if (/[A-Za-z0-9]/.test(literal)) pieces.push(literal);
    }
  }

  const text = pieces.join(" ").replace(/\s+/g, " ").trim();

  // A scan produces a handful of characters from an ICC profile name and
  // nothing else. The floor is low enough to let a sparse real page through and
  // high enough that colour-profile noise does not read as content.
  if (text.length < 40) return { ok: false, reason: "scanned" };

  return { ok: true, text };
}
