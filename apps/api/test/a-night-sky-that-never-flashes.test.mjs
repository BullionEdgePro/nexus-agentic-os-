// Light / dark ("Clear Sky" / "Night Sky"). Pinned as text: the correctness is
// in WHEN the theme is applied, WHERE it applies, and that it cannot break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p) => readFileSync(join(here, "..", "..", "..", ...p), "utf8");

const LAYOUT = read("apps", "web", "app", "layout.tsx");
const THEME = read("apps", "web", "lib", "theme.ts");
const TOGGLE = read("apps", "web", "app", "theme-toggle.tsx");
const DECK = read("apps", "web", "app", "deck", "deck.css");
const SHELL = read("apps", "web", "app", "console-shell.tsx");
const CONSOLE = read("apps", "web", "app", "deck-console.tsx");

test("the saved theme is applied before first paint, not after hydration", () => {
  // In <head>, before <body>: a dark console must never flash white.
  assert.match(LAYOUT, /<head>[\s\S]*dangerouslySetInnerHTML=\{\{ __html: THEME_BOOT \}\}[\s\S]*<\/head>[\s\S]*<body/);
  assert.match(LAYOUT, /<html lang="en" suppressHydrationWarning>/);
  // Storage can throw (private mode, blocked site data) — the boot must not.
  assert.match(THEME, /THEME_BOOT = `try\{/);
  // The constant lives in a plain module: from a "use client" file a server
  // component would receive a client reference, not the string.
  assert.ok(!/^"use client"/m.test(THEME));
});

test("the switch survives blocked storage and says what it does", () => {
  assert.match(TOGGLE, /try \{\s*localStorage\.setItem\(THEME_KEY, next\);\s*\} catch/);
  assert.match(TOGGLE, /role="switch"/);
  assert.match(TOGGLE, /aria-checked=\{dark\}/);
  assert.match(TOGGLE, /prefers-reduced-motion: reduce/);
});

// The storefront and the admin door joined the night on 2 Nov 2026 (spec
// 2026-11-02-storefront-cream-design.md §1); the customer links page keeps its look.
test("night reaches the console, the storefront and the admin door; the links page keeps its look", () => {
  assert.match(DECK, /html\[data-theme="dark"\] \.deck-root:not\(\.pl-root\) \{/);
  assert.match(DECK, /color-scheme: dark;/);
});

// Cream (1 Nov 2026): the button is a black pill by day and a cream pill at
// night, so the words on it flip with it. The rule that survives the change is
// the one that mattered: they read, in both themes.
test("the words on a button read in both themes", () => {
  const hex = (block, name) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(block)?.[1];
  const lum = (h) =>
    [1, 3, 5]
      .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const day = DECK.slice(DECK.indexOf("\n.deck-root {"));
  const night = DECK.slice(DECK.indexOf('html[data-theme="dark"] .deck-root:not(.pl-root) {'));
  for (const [theme, block] of [["light", day.slice(0, day.indexOf("\n}"))], ["dark", night.slice(0, night.indexOf("\n}"))]]) {
    const text = hex(block, "--on-accent");
    const pill = hex(block, "--signal");
    assert.ok(text && pill, `${theme}: --on-accent or --signal is missing`);
    assert.ok(ratio(text, pill) >= 4.5, `${theme}: ${text} on ${pill} is ${ratio(text, pill).toFixed(2)}:1`);
  }
});

// The switch moved from each page's header to the foot of the one dock
// (1 Nov 2026), and the admin front page now sits inside that dock's frame.
test("the switch is on every signed-in screen", () => {
  const PAGE = read("apps", "web", "app", "page.tsx");
  assert.match(SHELL, /<ThemeToggle compact \/>/);
  assert.match(PAGE, /<ConsoleShell[^>]*role="operator"[\s\S]*<DeckConsole \/>/);
  assert.doesNotMatch(CONSOLE, /<ThemeToggle/, "a second switch on the front page");
});
