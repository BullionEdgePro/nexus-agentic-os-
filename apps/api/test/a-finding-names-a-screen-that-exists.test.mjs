// A finding told somebody to go to a screen that does not exist.
//
// `wording-awaiting-review` shipped a few hours ago saying "Fill it in on the
// Wording screen and switch it on". There is no Wording screen. The phrases
// editor lives on the PROCEDURES page, under a heading called "What we say" —
// so the one finding whose whole purpose was to turn a silent state into a task
// sent the reader somewhere that is not there.
//
// It is the exact class of defect this codebase has spent a month removing:
// a sentence asserting something about the system that nobody checked against
// the system. Committing one while hunting them is worth a test rather than an
// apology.
//
// So: every deck screen a finding names must be a route that exists. Checked
// against the filesystem, because apps/web/app/deck/<name> IS the routing
// table — there is no separate list to fall out of date with.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");

const OPERATORS = readFileSync(
  join(root, "apps", "api", "src", "services", "operators.ts"),
  "utf8"
);

/** The deck's routes, read from the directory that defines them. */
function deckScreens() {
  const dir = join(root, "apps", "web", "app", "deck");
  return new Set(
    readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "page.tsx")))
      .map((e) => e.name.toLowerCase())
  );
}

/**
 * Screens a finding may name that are not their own deck route.
 *
 * The phrases editor is a section of the Procedures page rather than a page of
 * its own, so a finding that says "the Procedures screen, under What we say"
 * is naming something real and something findable — which is the property that
 * matters, not whether it has its own URL.
 */
const SECTIONS = new Set(["what we say"]);

test("every screen a finding names is one the deck has", () => {
  const screens = deckScreens();
  const named = [...OPERATORS.matchAll(/on the ([A-Z][A-Za-z ]{2,20}?) screen/g)].map((m) =>
    m[1].trim().toLowerCase()
  );

  assert.ok(named.length > 0, "no finding names a screen — did the phrasing change?");

  const missing = [...new Set(named)].filter(
    (name) => !screens.has(name) && !SECTIONS.has(name)
  );

  assert.deepEqual(
    missing,
    [],
    `these findings send somebody to a screen that does not exist: ${missing.join(", ")}\n` +
      `The deck has: ${[...screens].sort().join(", ")}`
  );
});

test("the sections a finding names are real too", () => {
  // A heading is as load-bearing as a route when it is what somebody scrolls
  // for. "What we say" is the phrases editor's heading on the Procedures page.
  const phrases = readFileSync(
    join(root, "apps", "web", "app", "deck", "procedures", "phrases-section.tsx"),
    "utf8"
  );
  assert.match(phrases, /What we say/, "the heading a finding points at was renamed");

  // And it really is on the Procedures page rather than one of its own.
  const procedures = readFileSync(
    join(root, "apps", "web", "app", "deck", "procedures", "page.tsx"),
    "utf8"
  );
  assert.match(procedures, /PhrasesSection/, "the phrases editor moved off the Procedures page");
});

test("the checker can actually fail", () => {
  // A check that cannot fail is worse than none. The scan is re-run against the
  // text as it shipped this afternoon, which named a screen that is not there.
  const screens = deckScreens();
  const shipped = 'Fill it in on the Wording screen and switch it on';
  const named = [...shipped.matchAll(/on the ([A-Z][A-Za-z ]{2,20}?) screen/g)].map((m) =>
    m[1].trim().toLowerCase()
  );
  assert.deepEqual(named, ["wording"]);
  assert.ok(!screens.has("wording"), "a Wording screen exists now — this test's premise is stale");
});
