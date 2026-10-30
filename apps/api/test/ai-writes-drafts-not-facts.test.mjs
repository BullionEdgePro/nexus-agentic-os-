/**
 * Bulk messaging's AI writer (30 Oct 2026): a brief in, three drafts out, and
 * nothing in a draft that the brief did not say. Drafts land in an editor the
 * admin reads before any send, so anything the parser lets through must be
 * safe to send as written — a "[Your Name]" would reach clients literally.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  WRITER_MODEL,
  draftRequest,
  parseDrafts,
  rewriteRequest,
  takeWriterTurn,
  writerSystemPrompt,
} from "../src/lib/message-writer.ts";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const voice = { name: "SFS International", tagline: "Real estate — sales, rentals & property management, UAE", summary: null };

test("the AI is told who is writing and the rules", () => {
  const quick = writerSystemPrompt("quick", voice);
  assert.match(quick, /SFS International/);
  assert.match(quick, /Real estate — sales/);
  assert.match(quick, /\{name\}/);
  assert.match(quick, /Never invent prices, dates, offers, links or phone numbers/);
  assert.match(quick, /600 characters/);
  const approved = writerSystemPrompt("approved", voice);
  assert.match(approved, /1024 characters/);
  assert.match(approved, /never start or end with \{name\}/);
  assert.match(approved, /Do not mention opting out/);
});

test("the request carries the brief, the choices and the format", () => {
  const request = draftRequest({ kind: "quick", brief: "Weekend viewings at Dubai Hills, AED 1.2M", tone: "friendly", length: "short", language: "ar" });
  assert.match(request, /Weekend viewings at Dubai Hills, AED 1\.2M/);
  assert.match(request, /exactly as written/);
  assert.match(request, /Arabic/);
  assert.match(request, /three/i);
  assert.match(request, /---/);
  const fix = rewriteRequest("approved", "Hi {name}, big sale!!!", "fix", "PROMOTIONAL");
  assert.match(fix, /Hi \{name\}, big sale!!!/);
  assert.match(fix, /PROMOTIONAL/);
});

test("drafts are split, cleaned and capped at three", () => {
  const text = "1. Hi {name}, viewings this weekend.\n---\n**Draft 2:** \"Hello {name}, reply to book.\"\n---\n\n---\nThird one.\n---\nFourth.";
  assert.deepEqual(parseDrafts(text, "quick"), ["Hi {name}, viewings this weekend.", "Hello {name}, reply to book.", "Third one."]);
});

test("made-up placeholders never reach an editor", () => {
  assert.deepEqual(parseDrafts("Hi [Your Name], hello\n---\nDear {customer}, hi\n---\nHi {name}, hello", "quick"), ["Hi {name}, hello"]);
});

test("an approved draft WhatsApp would refuse is dropped", () => {
  assert.deepEqual(
    parseDrafts("{name}, viewings this weekend.\n---\nHi {name}, viewings this weekend.", "approved"),
    ["Hi {name}, viewings this weekend."]
  );
});

test("thirty an hour, then wait", () => {
  for (let i = 0; i < 30; i++) assert.equal(takeWriterTurn("a", 0), true);
  assert.equal(takeWriterTurn("a", 1000), false);
  assert.equal(takeWriterTurn("a", 3_600_001), true);
  assert.equal(takeWriterTurn("b", 1000), true);
});

test("the writer asks Claude Opus 5.5, briefly, with a fallback and a timeout", () => {
  if (!process.env.NEXUS_WRITER_MODEL) assert.equal(WRITER_MODEL, "claude-opus-5-5");
  const src = read("apps", "api", "src", "lib", "message-writer.ts");
  assert.match(src, /model: WRITER_MODEL, effort: "low", fallback: true, maxTokens: 4000, timeoutMs: 45_000/);
});

test("the business's own words come from its row", () => {
  assert.match(read("packages", "db", "src", "organization-settings.ts"), /select name, tagline, summary from organizations where id = \$1/);
});

test("the writer routes check the limit before calling the model, and say so when the AI is away", () => {
  const route = read("apps", "api", "src", "routes", "admin-bulk-writing.ts");
  assert.ok(route.indexOf("takeWriterTurn(") < route.indexOf("writeDrafts("));
  assert.match(route, /brief\.length > 500/);
  assert.match(route, /The AI is not available right now — write the message yourself\./);
  assert.match(route, /429/);
  assert.match(read("apps", "api", "src", "index.ts"), /app\.route\("\/api\/bulk", adminBulkWritingRoute\);/);
});
