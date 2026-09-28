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

test("night is the console's; customers' pages and the admin door keep their look", () => {
  assert.match(DECK, /html\[data-theme="dark"\] \.deck-root:not\(\.lp\):not\(\.admin-root\):not\(\.pl-root\) \{/);
  assert.match(DECK, /color-scheme: dark;/);
});

test("text on a blue gradient stays white in both themes", () => {
  assert.match(DECK, /--on-accent: #ffffff;/);
  const night = DECK.slice(DECK.indexOf('html[data-theme="dark"] .deck-root:not(.lp)'));
  assert.ok(!/--on-accent:/.test(night.slice(0, night.indexOf("}"))), "the dark theme must not redefine --on-accent");
});

test("the switch is in the header of every signed-in screen", () => {
  assert.match(SHELL, /<ThemeToggle compact \/>/);
  assert.match(CONSOLE, /<ThemeToggle \/>/);
});
