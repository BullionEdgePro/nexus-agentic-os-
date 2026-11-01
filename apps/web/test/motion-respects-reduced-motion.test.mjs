/**
 * The motion kit (spec 2026-11-01-cream-foundation-design.md §3).
 *
 * Two promises. Numbers that count up end on exactly the figure the server
 * sent — prefix, separators, decimals and suffix intact — and leave anything
 * that is not a number alone. And a person whose device asks for reduced
 * motion gets none of it: every animation sits inside the no-preference query,
 * so outside it there is nothing left to move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseCount, formatCount } from "@/lib/motion";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a money figure keeps its prefix and separators", () => {
  assert.deepEqual(parseCount("$1,014,640"), { prefix: "$", value: 1014640, decimals: 0, suffix: "", grouped: true });
  assert.equal(formatCount(parseCount("$1,014,640"), 1014640), "$1,014,640");
  assert.equal(formatCount(parseCount("$1,014,640"), 2500), "$2,500");
});

test("decimals and suffixes survive the count", () => {
  assert.equal(parseCount("12.5").decimals, 1);
  assert.equal(formatCount(parseCount("12.5"), 3), "3.0");
  assert.deepEqual(parseCount("45%"), { prefix: "", value: 45, decimals: 0, suffix: "%", grouped: false });
  assert.equal(formatCount(parseCount("45%"), 7), "7%");
});

test("what is not a number is left alone", () => {
  assert.equal(parseCount("—"), null);
  assert.equal(parseCount(""), null);
  assert.equal(parseCount("No data this week"), null);
});

/** motion.css with every no-preference block removed, braces matched. */
function outsideNoPreference(css) {
  const head = /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{/g;
  let out = "";
  let from = 0;
  for (let m; (m = head.exec(css)); ) {
    out += css.slice(from, m.index);
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    from = i;
    head.lastIndex = i;
  }
  return out + css.slice(from);
}

test("reduced motion leaves nothing moving", () => {
  const css = read("../app/motion.css");
  const rest = outsideNoPreference(css);
  assert.doesNotMatch(rest, /\banimation(-name)?\s*:/, "an animation outside the no-preference query");
  assert.doesNotMatch(rest, /\btransition\s*:/, "a transition outside the no-preference query");
  assert.match(css, /@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/);
  assert.match(css, /view-transition-name:\s*nx-rail/);
});

test("cards rise in order without waiting for the page's code", () => {
  // The stagger is pure CSS (nth-child), so server-rendered cards animate
  // from the first paint instead of flashing in and then hiding to animate.
  const css = read("../app/motion.css");
  assert.match(css, /:nth-child\(12\)\s*\{\s*--i:\s*11;?\s*\}/);
  assert.match(css, /:nth-child\(n\s*\+\s*13\)\s*\{\s*animation:\s*none;?\s*\}/);
});

test("the shell mounts the kit once", () => {
  const shell = read("../app/console-shell.tsx");
  assert.match(shell, /import "\.\/motion\.css";/);
  assert.match(shell, /<MotionBoot \/>/);
});

test("the theme's circle reveal is kept for the theme switch, not every page change", () => {
  const deck = read("../app/deck/deck.css");
  assert.match(deck, /html\.nx-theme-switch::view-transition-new\(root\)\s*\{\s*animation:\s*nx-sky-reveal/);
  assert.doesNotMatch(deck, /\n::view-transition-new\(root\)\s*\{\s*animation:\s*nx-sky-reveal/);
  const toggle = read("../app/theme-toggle.tsx");
  assert.match(toggle, /classList\.add\("nx-theme-switch"\)/);
  assert.match(toggle, /classList\.remove\("nx-theme-switch"\)/);
});
