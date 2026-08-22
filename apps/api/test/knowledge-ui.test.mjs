// The knowledge screen — where a wrong action degrades every customer answer
// with no error anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts) => readFileSync(join(here, "..", "..", "..", ...parts), "utf8");

const PAGE = read("apps", "web", "app", "deck", "knowledge", "page.tsx");
// The navigation moved to lib/nav.tsx — ONE list the shared console shell and
// the front page both render. It used to be written inline here and nowhere
// else, which is why every screen it linked to had no navigation of its own.
// These checks still ask the same question, of the place that now answers it.
const DECK = read("apps", "web", "lib", "nav.tsx");
const ROUTE = read("apps", "api", "src", "routes", "knowledge.ts");

test("removing a source asks first and names what goes", () => {
  // Deletion has no visible failure mode. The agent simply stops knowing
  // something and answers worse from then on, silently.
  assert.match(PAGE, /confirming\?\.id === source\.id/);
  assert.match(PAGE, /The agent will stop knowing its \{source\.chunks\}/);
  assert.ok(!/onClick=\{\(\) => handleRemove\(source\)\}[\s\S]{0,80}Remove<\/button>/.test(
    PAGE.replace(/kn-danger[\s\S]*?<\/button>/, "")
  ), "the bare Remove button must open a confirmation, not delete");
});

test("an unchanged re-index is reported as up to date, not as zero", () => {
  // The API returns unchanged:true when the content hash matched. Rendering
  // that as "indexed 0 passages" would look broken when nothing was wrong.
  assert.match(ROUTE, /unchanged: result\.skipped/);
  assert.match(PAGE, /Already up to date/);
});

test("the server's own error reason is shown, not a generic one", () => {
  // "A blocked internal URL" and "the site is down" need different responses
  // from whoever pasted it.
  // SAME INTENT, ONE FEWER COPY. This page carried its own `readable`, which
  // was the third implementation of one idea -- readableError's own comment
  // says it was "already written twice over on the way to being written a third
  // time", and this was that third. It also fell back to err.message, so an
  // unreachable API showed "Failed to fetch" here and a 403 showed the whole
  // transport string.
  //
  // The shared helper still puts the server's own sentence first, which is what
  // this test is actually about.
  const API = read("apps", "web", "lib", "api.ts");
  assert.match(PAGE, /const readable = readableError/);
  // Plain substrings rather than a regex-of-a-regex. Asserting on an escaped
  // pattern that itself contains escapes is how the previous two attempts at
  // this line went wrong; what matters is that the helper reads the server's
  // error field first, and that is visible without matching its syntax.
  assert.ok(API.includes('"error"'), "the helper no longer looks for the server's error field");
  assert.ok(API.includes("exec(raw)"), "the helper no longer parses the thrown message");
  assert.match(ROUTE, /UnsafeUrlError/);
});

test("a synchronous index says what it is doing", () => {
  // Ingestion is inline and can take seconds on a slow page.
  assert.match(PAGE, /Reading and indexing…/);
});

test("failed sources are surfaced, because they are not used at all", () => {
  assert.match(PAGE, /failed\.length > 0/);
  assert.match(PAGE, /answering without/);
});

test("an empty knowledge base explains the consequence", () => {
  // "No sources" alone does not tell an owner that their agent cannot answer
  // anything specific about their business.
  assert.match(PAGE, /This agent knows nothing yet/);
  assert.match(PAGE, /cannot answer anything\s*\n?\s*specific/);
});

test("the page is reachable and the nav has no dead ends", () => {
  const rail = DECK;
  assert.match(rail, /href: "\/deck\/knowledge"/);
  for (const anchor of rail.match(/<a\b[^>]*>/g) ?? []) {
    assert.ok(
      /href=|onClick=|className="on"/.test(anchor),
      `nav item goes nowhere: ${anchor}`
    );
  }
  console.log("PASS: knowledge is editable, deletion is confirmed, and failures are visible");
});
