// SFS International's agent had four indexed passages of Lorem ipsum it could
// retrieve and cite: /privacy/ is an unreplaced Houzez theme page whose whole
// body is filler, and /terms-and-conditions/ carries two paragraphs of it among
// seven real ones.
//
// The existing curation excludes theme pages BY URL — grid-full-width,
// with-parallax, apartments-in-new-york. That cannot work for a page called
// /privacy/, which is exactly what a real privacy policy is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPlaceholderText, dropPlaceholderChunks, chunkText } from "@nexus/knowledge";

const LOREM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Quisque ut lacinia ex. " +
  "Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.";

const REAL =
  "SFS International Real Estate L.L.C. is a Dubai brokerage. We handle sales, " +
  "leasing and property management across the emirate, and our team can arrange " +
  "viewings for any listing you have seen advertised.";

test("filler is recognised, real copy is not", () => {
  assert.equal(isPlaceholderText(LOREM), true);
  assert.equal(isPlaceholderText(REAL), false);
  // The actual opening of SFS's /privacy/ page.
  assert.equal(
    isPlaceholderText("Lorem ipsum dolor sit amet, consectetur adipiscing elit. Quisque ut lacinia ex."),
    true
  );
});

test("a page that merely mentions the specimen is kept", () => {
  // A style guide, a typography article, or a design agency explaining its
  // process says "lorem ipsum" once inside a paragraph of genuine English.
  // Deleting that would be the filter doing exactly the damage it prevents.
  const aboutIt =
    "Our design team never ships a page still carrying lorem ipsum. Every " +
    "template we hand over is populated with the client's own copy, reviewed " +
    "by an editor, and signed off before it goes live. We have turned away " +
    "work rather than publish a site with placeholder text on it, because a " +
    "visitor who finds filler stops believing anything else on the page.";
  assert.equal(isPlaceholderText(aboutIt), false);
});

test("two independent markers are conclusive regardless of length", () => {
  // Length alone is not the test: a long page of filler is still filler.
  const long = (LOREM + " ").repeat(12);
  assert.ok(long.length > 400);
  assert.equal(isPlaceholderText(long), true);
});

test("judgement is per chunk, so a part-filler page keeps its real content", () => {
  // /terms-and-conditions/ is the case: two paragraphs of Lorem ipsum among
  // seven of real terms. Refusing the page throws away the seven; keeping it
  // whole leaves filler the agent can quote to a customer. Neither is
  // acceptable, so the unit of judgement is the chunk.
  const chunks = [
    { index: 0, content: REAL, tokenEstimate: 40 },
    { index: 1, content: LOREM, tokenEstimate: 40 },
    { index: 2, content: REAL, tokenEstimate: 40 },
  ];
  const kept = dropPlaceholderChunks(chunks);
  assert.equal(kept.length, 2);
  assert.ok(kept.every((c) => c.content === REAL));
});

test("survivors are renumbered contiguously", () => {
  // chunk_index is stored and ordered on. Gaps work today and break the first
  // thing that assumes a source's indexes run 0..n-1.
  const kept = dropPlaceholderChunks([
    { index: 0, content: LOREM, tokenEstimate: 40 },
    { index: 1, content: REAL, tokenEstimate: 40 },
    { index: 2, content: LOREM, tokenEstimate: 40 },
    { index: 3, content: REAL, tokenEstimate: 40 },
  ]);
  assert.deepEqual(kept.map((c) => c.index), [0, 1]);
});

test("an all-filler page yields nothing, which the caller reports", () => {
  // Chunked for real rather than hand-built, so this exercises the path a page
  // actually takes. ingest.ts marks this case FAILED with a message naming the
  // cause, instead of storing it as "indexed, 0 passages" — which would look
  // healthy on the knowledge screen and pass the operator sweep.
  const page = (LOREM + "\n\n").repeat(6);
  const chunks = chunkText(page);
  assert.ok(chunks.length > 0, "the page must produce chunks before filtering");
  assert.deepEqual(dropPlaceholderChunks(chunks), []);
});

test("real content is never dropped wholesale", () => {
  const page = (REAL + "\n\n").repeat(6);
  const chunks = chunkText(page);
  assert.equal(dropPlaceholderChunks(chunks).length, chunks.length);
  console.log("PASS: filler is not knowledge");
});
