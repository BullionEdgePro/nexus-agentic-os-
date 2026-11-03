/**
 * The AI writer on Bulk messaging (3 Nov 2026): a brief the AI declines comes
 * back as a note to read, never as a draft with Use this; and a draft's preview
 * says whose name it shows, since {name} is filled in per customer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const WRITER = readFileSync(join(here, "..", "app", "deck", "bulk", "ai-writer.tsx"), "utf8");
const API = readFileSync(join(here, "..", "lib", "api.ts"), "utf8");

test("a declined brief shows as a note, with no Use this", () => {
  assert.match(API, /writeBulkDrafts\([^)]*\): Promise<\{ drafts: string\[\]; note\?: string \| null \}>/);
  assert.match(WRITER, /setNote\(data\.note \?\? ""\)/);
  assert.match(WRITER, /\{note \? \(\s*<p className="ai-note"/);
});

test("the drafts say whose name the preview shows", () => {
  assert.match(WRITER, /As \{firstName\(sampleName\)\} would see it — each customer gets their own name\./);
});
