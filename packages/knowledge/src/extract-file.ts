/**
 * What a document actually says, or a refusal saying why not.
 *
 * ============================================================
 * WHY A REFUSAL IS A FEATURE HERE
 * ============================================================
 *
 * Every other connector in this package produces text that a person could have
 * read for themselves — a page they can open, a paragraph they typed. A file is
 * the first one where extraction can go wrong SILENTLY: a scanned PDF is a
 * stack of images, and a parser handed one returns an empty string rather than
 * an error. Index that and the source says "ok, 0 chunks", the deck lists it
 * beside the working ones, and the agent answers "I'll check with a colleague"
 * to every question the document would have answered.
 *
 * So nothing here returns empty text as a success. A file that yields no words
 * is refused with the reason, and the reason names the likely cause, because
 * "a scan of a document is a picture of words" is not obvious to somebody who
 * can read it perfectly well on their own screen.
 *
 * ============================================================
 * WHY THESE FORMATS
 * ============================================================
 *
 * Text and Markdown need no parser. HTML reuses the extractor the URL connector
 * already uses, so a saved page and a fetched one are chunked the same way.
 * PDF and Word need real parsers, and both chosen here are pure JavaScript —
 * `pdf-parse` at 1.x, whose only dependencies are `debug` and `node-ensure`,
 * rather than 2.x, which pulls a native canvas binary into an image this
 * platform builds on a small VPS.
 *
 * Anything else is refused by name. A .pages or .key file arriving as
 * application/octet-stream and being indexed as its own binary would be the
 * same silent-noise failure by another route.
 */
import { createRequire } from "node:module";
import { htmlToText } from "./html.js";

/** Bytes. Beyond this a document is a library, not an answer to a question. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Characters of extracted text below which a file is treated as unreadable.
 *
 * Not zero. A scanned PDF frequently yields a handful of characters -- a page
 * number, a stray ligature the OCR layer left behind -- and "3 characters" is
 * the same failure as "0 characters" dressed up as success.
 */
export const MIN_TEXT_CHARS = 40;

export interface ExtractedFile {
  text: string;
  /** What it was read as, recorded on the source so the deck can say. */
  format: "text" | "markdown" | "html" | "pdf" | "word";
}

export interface FileRefusal {
  reason: string;
}

const BY_EXTENSION: Readonly<Record<string, ExtractedFile["format"]>> = {
  txt: "text",
  text: "text",
  log: "text",
  csv: "text",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  pdf: "pdf",
  docx: "word",
};

export function formatOf(filename: string): ExtractedFile["format"] | null {
  const dot = filename.lastIndexOf(".");
  if (dot === -1) return null;
  return BY_EXTENSION[filename.slice(dot + 1).toLowerCase()] ?? null;
}

/** The formats a person can be told about, in the order they are likeliest. */
export const READABLE_FORMATS = "PDF, Word (.docx), text, Markdown or HTML";

/**
 * Read one uploaded file.
 *
 * Returns a refusal rather than throwing for anything the caller should show a
 * person: an unknown format, an empty document, a file too large. A parser that
 * throws on a corrupt PDF is caught here and turned into one of those, because
 * a stack trace reaching a screen tells nobody what to do next.
 */
export async function extractFile(
  filename: string,
  bytes: Uint8Array
): Promise<ExtractedFile | FileRefusal> {
  if (bytes.byteLength === 0) return { reason: "That file is empty." };
  if (bytes.byteLength > MAX_FILE_BYTES) {
    const mb = Math.round(MAX_FILE_BYTES / (1024 * 1024));
    return { reason: `That file is larger than ${mb}MB. Split it, or index the part that answers questions.` };
  }

  const format = formatOf(filename);
  if (!format) {
    return {
      reason:
        `"${filename}" is not a format this can read. Upload ${READABLE_FORMATS}. ` +
        `A .doc from before 2007 has to be saved as .docx first.`,
    };
  }

  let text: string;
  try {
    text = await readAs(format, bytes);
  } catch (err) {
    // Corrupt, encrypted, or a format lying about its extension. All three look
    // the same from here and all three have the same answer for the person
    // holding the file.
    const detail = err instanceof Error ? err.message : String(err);
    return {
      reason: `That file could not be read (${detail}). If it is password-protected, remove the password and try again.`,
    };
  }

  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_CHARS) {
    return {
      reason:
        format === "pdf"
          ? "No text could be read from that PDF. It is most likely a scan -- a picture of the pages rather than the words -- so there is nothing to index. Run it through OCR, or paste the text in."
          : "That file contains almost no text, so there would be nothing to answer questions from.",
    };
  }

  return { text: trimmed, format };
}

async function readAs(format: ExtractedFile["format"], bytes: Uint8Array): Promise<string> {
  if (format === "text" || format === "markdown") {
    // Markdown is left as-is rather than stripped: its headings and lists are
    // real structure and the chunker splits on the blank lines between them.
    return new TextDecoder("utf-8").decode(bytes);
  }

  if (format === "html") {
    return htmlToText(new TextDecoder("utf-8").decode(bytes));
  }

  if (format === "pdf") {
    // Loaded through createRequire rather than a bare import, for two reasons
    // that happen to point the same way.
    //
    // The LIBRARY entry point, not the package root: pdf-parse@1's index.js
    // runs a self-test against a file it does not publish whenever it decides
    // it is the main module, which under an ESM loader it can be.
    //
    // And the package ships no types. A .d.ts beside this file is invisible to
    // the other workspaces that compile these sources directly, so the type is
    // stated here, narrowly -- `text` is the only field read, and describing
    // the rest would be inventing a contract nobody checked.
    type PdfParse = (data: Buffer) => Promise<{ text?: unknown }>;
    const load = createRequire(import.meta.url);
    const pdfParse = load("pdf-parse/lib/pdf-parse.js") as PdfParse;
    const result = await pdfParse(Buffer.from(bytes));
    return typeof result?.text === "string" ? result.text : "";
  }

  const { default: mammoth } = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
  return typeof result?.value === "string" ? result.value : "";
}
