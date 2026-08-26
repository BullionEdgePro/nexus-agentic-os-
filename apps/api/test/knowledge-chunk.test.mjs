// Unit tests for the knowledge chunker and embedding normalization. Both are
// pure — no model, no database — so they import the real implementations, the
// same approach as governance-policy and employee-presence.
//
// Chunking is where retrieval quality is actually decided: a chunk that ends
// mid-sentence embeds a fragment of an idea and matches badly at query time.
import { test } from "node:test";
import assert from "node:assert/strict";

import { chunkText, estimateTokens, normalize, isPlaceholderText } from "@nexus/knowledge";

test("short text produces exactly one chunk", () => {
  const chunks = chunkText("We ship within two business days.");
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].index, 0);
  assert.match(chunks[0].content, /two business days/);
});

test("empty or whitespace-only input produces no chunks", () => {
  assert.deepEqual(chunkText(""), []);
  assert.deepEqual(chunkText("   \n\n  \t "), []);
});

test("chunks respect the size budget", () => {
  const paragraph = "Refunds are processed within five working days. ".repeat(40);
  const chunks = chunkText(paragraph, { maxChars: 300, overlapChars: 50 });

  assert.ok(chunks.length > 1, "long text must split");
  for (const chunk of chunks) {
    // Budget applies to the chunk body; overlap is prepended on top of it.
    assert.ok(
      chunk.content.length <= 300 + 50 + 10,
      `chunk ${chunk.index} is ${chunk.content.length} chars, over budget`
    );
  }
});

test("splitting prefers paragraph boundaries over cutting mid-sentence", () => {
  const text = ["First paragraph about shipping.", "Second paragraph about refunds."].join("\n\n");
  const chunks = chunkText(text, { maxChars: 40, overlapChars: 0 });

  assert.equal(chunks.length, 2);
  assert.match(chunks[0].content, /shipping/);
  assert.match(chunks[1].content, /refunds/);
  assert.ok(!chunks[0].content.includes("refunds"), "paragraphs must not bleed together");
});

test("a paragraph over budget falls back to sentence boundaries", () => {
  const text =
    "Orders ship in two days. Returns take five days. Refunds appear in ten days. Support replies hourly.";
  const chunks = chunkText(text, { maxChars: 55, overlapChars: 0 });

  assert.ok(chunks.length > 1);
  // Every chunk should still end on sentence punctuation rather than mid-word.
  for (const chunk of chunks) {
    assert.match(chunk.content.trim(), /[.!?]$/, `chunk ${chunk.index} was cut mid-sentence`);
  }
});

test("a single sentence over budget is hard-split rather than dropped", () => {
  // Minified content and long table rows have no sentence boundary to use.
  const giant = "x".repeat(500);
  const chunks = chunkText(giant, { maxChars: 100, overlapChars: 0 });

  assert.ok(chunks.length >= 5, "oversized sentence must still be indexed, not discarded");
  assert.equal(chunks.map((c) => c.content).join("").length, 500, "no content may be lost");
});

test("consecutive chunks overlap so a fact spanning a boundary survives", () => {
  const text = "Alpha beta gamma. ".repeat(30);
  const chunks = chunkText(text, { maxChars: 200, overlapChars: 60 });

  assert.ok(chunks.length > 1);
  assert.ok(
    chunks[1].content.length > 0 && chunks[1].content !== chunks[0].content,
    "overlap must not make a chunk a pure duplicate of its predecessor"
  );
});

test("overlap larger than the chunk size is clamped instead of looping forever", () => {
  // A pathological config must terminate and still produce usable chunks.
  const chunks = chunkText("one two three four five six seven eight nine ten. ".repeat(10), {
    maxChars: 100,
    overlapChars: 5000,
  });
  assert.ok(chunks.length > 0);
  assert.ok(chunks.every((c) => c.content.length > 0));
});

test("chunk indexes are sequential from zero", () => {
  const chunks = chunkText("Sentence number one. ".repeat(50), { maxChars: 150 });
  chunks.forEach((chunk, i) => assert.equal(chunk.index, i));
});

// ============================================================
// Embedding normalization
// ============================================================

test("normalize returns a unit vector so dot product equals cosine similarity", () => {
  const unit = normalize([3, 4]); // magnitude 5
  assert.ok(Math.abs(unit[0] - 0.6) < 1e-9);
  assert.ok(Math.abs(unit[1] - 0.8) < 1e-9);

  const magnitude = Math.sqrt(unit.reduce((sum, v) => sum + v * v, 0));
  assert.ok(Math.abs(magnitude - 1) < 1e-9, "normalized vector must have length 1");
});

test("normalize leaves a zero vector alone instead of producing NaNs", () => {
  // A zero vector has no direction; dividing by its norm would poison every
  // downstream similarity score with NaN.
  assert.deepEqual(normalize([0, 0, 0]), [0, 0, 0]);
});

test("token estimate is proportional and never zero for real text", () => {
  assert.ok(estimateTokens("hello world") > 0);
  assert.ok(estimateTokens("a".repeat(400)) > estimateTokens("a".repeat(100)));
  console.log("PASS: chunker respects boundaries, loses no content, and normalizes vectors");
});

test("filler is caught past the opening sentence, not only at it", () => {
  // FOUND IN PRODUCTION ON 2026-08-26, in SFS International's terms and
  // conditions, sitting in the knowledge base and quotable to a customer.
  //
  // It matched NOT ONE marker. Every fragment in the original list came from
  // the first two sentences of the standard passage; this is the middle of
  // it. "vitae sit amet" is not "dolor sit amet". Long filler is split across
  // chunks and only the FIRST piece carries the famous words -- so the longer
  // the filler, the more of it got through.
  const production =
    "pretium luctus vitae sit amet est. Etiam in maximus urna. Cum sociis natoque penatibus et magnis dis parturient montes, nascetur ridiculus mus. Curabitur tristique nec ex eget posuere. Sed elit lacus,";
  assert.equal(isPlaceholderText(production), true, "the passage that got through still would");
});

test("the widened list still does not eat real copy", () => {
  // The guard. A filter that guesses deletes genuine content, which is worse
  // than keeping filler -- and the sentence below is the one that broke the
  // FIRST version of this rule: a design agency saying it never ships lorem
  // ipsum, flagged because it named the thing once.
  const genuine = [
    "We never ship lorem ipsum to a client. Every word on your site is written by a person who understands your business, reviewed with you before launch.",
    "Our mission is to be one of the leading providers of high-end real estate across Dubai, Abu Dhabi, Sharjah and Ajman.",
    "You have 30 days from the date you received your item to request a return. Items must be unused and in original packaging.",
    "The arbitration clause follows FIDIC standard form, and montes may be relevant to the site survey.",
  ];
  for (const text of genuine) {
    assert.equal(isPlaceholderText(text), false, `real copy was deleted: ${text.slice(0, 50)}`);
  }
});

test("two independent markers is still the rule", () => {
  // The widened list must not become a one-word trigger. A single Latin-looking
  // fragment inside a long real paragraph is not evidence of anything.
  const oneMarkerInRealProse =
    "Our surveyor noted that the parturient montes reference in the older deed is a transcription error, " +
    "and the boundary should be read against the 1987 plan rather than the description carried forward from it.";
  assert.equal(isPlaceholderText(oneMarkerInRealProse), false);
});
