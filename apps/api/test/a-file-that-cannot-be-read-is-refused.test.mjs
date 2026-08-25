/**
 * The file connector, and the one thing it must never do.
 *
 * ============================================================
 * WHY THE REFUSALS ARE THE FEATURE
 * ============================================================
 *
 * Every other connector produces text a person could have read for themselves:
 * a page they can open, a paragraph they typed. A file is the first one where
 * extraction fails SILENTLY. A scanned PDF is a stack of images, and a parser
 * handed one returns an empty string rather than an error.
 *
 * Index that and every visible signal says it worked. The upload returns ok.
 * The source sits in the knowledge list beside the working ones. `broken-
 * knowledge` does not fire, because the source did not FAIL. And the agent
 * answers "I'll check with a colleague" to every question that document was
 * uploaded to answer -- which is the exact shape of the retrieval bug that hid
 * on this platform for weeks: a silent empty result that reads as a fact.
 *
 * So an unreadable file is refused, out loud, with the likeliest cause named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  extractFile,
  formatOf,
  MAX_FILE_BYTES,
  MIN_TEXT_CHARS,
} from "@nexus/knowledge";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const ROUTE = readFileSync(join(root, "apps", "api", "src", "routes", "knowledge.ts"), "utf8");

const bytes = (s) => new TextEncoder().encode(s);

// Long enough to clear MIN_TEXT_CHARS, so a test about formats is not
// accidentally a test about the length floor.
const PROSE =
  "Customers may return unworn items within fourteen days of delivery for a full refund.";

// ============================================================
// What it will and will not read
// ============================================================

test("the formats are matched on extension, whatever the casing", () => {
  assert.equal(formatOf("policy.txt"), "text");
  assert.equal(formatOf("HOURS.MD"), "markdown");
  assert.equal(formatOf("Delivery.HtMl"), "html");
  assert.equal(formatOf("warranty.PDF"), "pdf");
  assert.equal(formatOf("fees.docx"), "word");
});

test("a format nobody can read is refused by name, not indexed as noise", () => {
  // A .pages arriving as application/octet-stream and being indexed as its own
  // binary is the same silent-noise failure by another route.
  assert.equal(formatOf("deck.pages"), null);
  assert.equal(formatOf("archive.zip"), null);
  assert.equal(formatOf("README"), null, "a file with no extension must not be guessed at");
});

test("plain text and markdown come through intact", async () => {
  const txt = await extractFile("policy.txt", bytes(PROSE));
  assert.ok(!("reason" in txt), "plain text was refused");
  assert.equal(txt.format, "text");
  assert.ok(txt.text.includes("fourteen days"));

  // Markdown keeps its markers: the headings and lists are real structure and
  // the chunker splits on the blank lines between them.
  const md = await extractFile("hours.md", bytes("# Opening hours\n\n" + PROSE));
  assert.ok(!("reason" in md));
  assert.equal(md.format, "markdown");
  assert.ok(md.text.includes("# Opening hours"), "markdown structure was stripped");
});

test("a saved page is read the same way a fetched one is", async () => {
  // Reusing htmlToText rather than a second extractor, so an uploaded page and
  // a crawled one chunk identically -- and so the nav and footer are dropped
  // here too. Without that, every chunk of every page carries the same
  // boilerplate and similarity scores flatten toward meaningless.
  const html =
    "<html><body><nav>Home Shop Contact</nav><main><h1>Delivery</h1><p>" +
    PROSE +
    "</p></main><footer>copyright 2026</footer></body></html>";
  const out = await extractFile("delivery.html", bytes(html));
  assert.ok(!("reason" in out), "html was refused");
  assert.ok(out.text.includes("Delivery"));
  assert.ok(!out.text.includes("Home Shop Contact"), "the nav was indexed as prose");
  assert.ok(!out.text.includes("copyright"), "the footer was indexed as prose");
});

// ============================================================
// The refusals
// ============================================================

test("an empty file is refused", async () => {
  const out = await extractFile("a.txt", new Uint8Array(0));
  assert.ok("reason" in out);
  assert.match(out.reason, /empty/i);
});

test("a file with almost no text in it is refused, not indexed as a success", async () => {
  // NOT a zero check. A scan frequently yields a handful of characters -- a
  // page number, a stray ligature -- and "3 characters" is the same failure as
  // "0 characters" wearing a success message.
  assert.ok(MIN_TEXT_CHARS > 1, "the floor is effectively zero, which is the bug");
  const out = await extractFile("a.txt", bytes("hi"));
  assert.ok("reason" in out);
  assert.match(out.reason, /nothing to answer questions from/);
});

test("a PDF with no text layer says it is probably a scan", async () => {
  // The sentence matters as much as the refusal. "A scan of a document is a
  // picture of words" is not obvious to somebody who can read it perfectly
  // well on their own screen, and without it they upload it again.
  const out = await extractFile("scan.pdf", bytes("%PDF-1.4 not really a pdf"));
  assert.ok("reason" in out, "a corrupt or textless PDF was accepted");
  assert.ok(out.reason.length > 40, "a refusal that says 'failed' teaches nothing");
});

test("a file too large to be an answer is refused before it is parsed", async () => {
  const out = await extractFile("book.txt", new Uint8Array(MAX_FILE_BYTES + 1));
  assert.ok("reason" in out);
  assert.match(out.reason, /larger than/);
});

test("a parser that throws becomes a sentence, never a stack trace", async () => {
  // Corrupt, encrypted, and lying-about-its-extension all look the same from
  // here, and all three have the same answer for the person holding the file.
  const out = await extractFile("fees.docx", bytes("this is not a zip archive"));
  assert.ok("reason" in out, "a corrupt docx was accepted");
  assert.match(out.reason, /password/i, "an encrypted file is the likeliest cause and should be named");
});

// ============================================================
// How the route treats them
// ============================================================

test("an unreadable file is the caller's 400, not the server's 502", () => {
  // A 502 would say the platform broke. It did not: the file cannot be read,
  // and the person holding it is the only one who can do anything about that.
  const at = ROUTE.indexOf('knowledgeRoute.post("/:slug/knowledge/file"');
  assert.ok(at > -1, "the file route is gone");
  const body = ROUTE.slice(at, ROUTE.indexOf("knowledgeRoute.delete", at));
  assert.ok(
    body.includes('if ("reason" in extracted) return c.json({ error: extracted.reason }, 400);'),
    "a refusal must reach the caller as a 400 carrying its own sentence"
  );
});

test("an uploaded document is recorded as one", () => {
  // 'file' has been allowed by the schema since migration 003 and never had a
  // writer. Recording it matters when a source needs re-checking and nobody
  // remembers whether it was typed in or uploaded.
  const at = ROUTE.indexOf('knowledgeRoute.post("/:slug/knowledge/file"');
  const body = ROUTE.slice(at, ROUTE.indexOf("knowledgeRoute.delete", at));
  assert.ok(body.includes('kind: "file"'), "an uploaded document is indistinguishable from typed text");
});

test("the size is checked before the bytes are pulled into memory", () => {
  // extractFile holds the rule for every caller; the route checks first so a
  // 500MB upload is not buffered only to be told no.
  const at = ROUTE.indexOf('knowledgeRoute.post("/:slug/knowledge/file"');
  const body = ROUTE.slice(at, ROUTE.indexOf("knowledgeRoute.delete", at));
  const sizeAt = body.indexOf("file.size > MAX_FILE_BYTES");
  const readAt = body.indexOf("arrayBuffer()");
  assert.ok(sizeAt > -1 && readAt > -1);
  assert.ok(sizeAt < readAt, "the size check must come before the file is read into memory");
});
