/**
 * One sidebar for everyone (spec 2026-11-01-cream-foundation-design.md §2).
 *
 * The admin front page was the last screen that built its own header and rail,
 * which is why the sidebar looked different from one screen to the next. It
 * now sits in ConsoleShell like every other signed-in page, and its header
 * tools (work, notifications, account) moved into the shell's top bar — for
 * admins on every page, never for staff.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the admin front page is wrapped in the shared frame", () => {
  const page = read("../app/page.tsx");
  assert.match(page, /<ConsoleShell[^>]*role="operator"[^>]*signedInAs=\{session\.sub\}[\s\S]*<DeckConsole/);
});

test("the admin front page no longer builds its own frame", () => {
  const deck = read("../app/deck-console.tsx");
  assert.doesNotMatch(deck, /className="topbar"/);
  assert.doesNotMatch(deck, /<nav className="rail"/);
  assert.doesNotMatch(deck, /initDeckFx/);
  assert.doesNotMatch(deck, /<CommandPalette/);
  assert.doesNotMatch(deck, /className="bg"/);
  assert.doesNotMatch(deck, /cur-dot/);
  // Its own card styles are keyed off .app / .main, so those names stay.
  assert.match(deck, /className="app"[\s\S]*className="main"/);
});

test("the shell's top bar is for admins only", () => {
  const shell = read("../app/console-shell.tsx");
  assert.match(shell, /signedInAs\?: string/);
  const bar = shell.match(/role === "operator" && !pathname\.startsWith\("\/inbox"\) \? \(\s*<header className="shell-top"[\s\S]*?<\/header>/);
  assert.ok(bar, "no admin-only shell-top header");
  for (const menu of ["<WorkMenu />", "<NotificationsMenu />", "<AccountMenu signedInAs="]) {
    assert.ok(bar[0].includes(menu), `${menu} is not in the admin top bar`);
  }
  const outside = shell.replace(bar[0], "");
  assert.doesNotMatch(outside, /<WorkMenu|<NotificationsMenu|<AccountMenu/);
});

test("every signed-in layout passes who is signed in", () => {
  for (const file of ["../app/deck/layout.tsx", "../app/inbox/layout.tsx"]) {
    const layout = read(file);
    assert.match(layout, /<ConsoleShell/);
    assert.match(layout, /signedInAs=\{session\?\.sub/);
  }
});

test("inside the frame, the front page's grid steps aside", () => {
  const css = read("../app/console-shell.css");
  assert.match(css, /\.deck-root\.shell \.app\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.shell-top\s*\{/);
});
