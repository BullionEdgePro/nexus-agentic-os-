/**
 * What the whole-branch review of the Cream foundation found (1 Nov 2026),
 * each pinned so it cannot come back:
 *
 *  - the dock scrolled away with the page, and the front page scrolled inside
 *    itself as a second page;
 *  - the pill never slid (and from the front page it would have started over
 *    the logo);
 *  - a finished entrance animation pinned every card's lift and opacity;
 *  - a dock saved "shrunk" broke the phone bar;
 *  - the admin's top bar pushed the inbox's composer below the fold;
 *  - white labels on buttons that turn cream at night;
 *  - staff on phones had no way to mute;
 *  - the theme's circle reveal clipped only the margins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { THEME_BOOT } from "@/lib/theme";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const SHELL_CSS = read("../app/console-shell.css");
const SHELL = read("../app/console-shell.tsx");
const MOTION = read("../app/motion.css");

/** Every rule's selector and body, comments removed. */
function rules(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]]);
}

/** The body of the @media block that starts with `head`, braces matched. */
function mediaBlock(css, head) {
  const at = css.indexOf(head);
  assert.ok(at >= 0, `no ${head}`);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(at, i);
  }
  throw new Error("unclosed");
}

test("the dock stays on screen while the page scrolls", () => {
  // overflow-x: hidden on the shell's own root made it a scroll container that
  // never scrolls, so `position: sticky` stuck to nothing. clip does not.
  const shell = rules(SHELL_CSS).find(([sel]) => sel === ".deck-root.shell");
  assert.ok(shell, "no .deck-root.shell rule");
  assert.match(shell[1], /overflow-x:\s*clip/);
});

test("the front page scrolls as one page, not a page inside a page", () => {
  const app = rules(SHELL_CSS).find(([sel]) => sel === ".deck-root.shell .app");
  assert.match(app[1], /height:\s*auto/);
  const page = rules(SHELL_CSS).find(([sel]) => sel === ".deck-root.shell .shell-main > .deck-root");
  assert.ok(page, "pages are still forced to a full screen of height under the top bar");
  assert.match(page[1], /min-height:\s*0/);
});

test("the pill slides from the page just left, not from the logo", () => {
  assert.match(SHELL, /querySelectorAll<HTMLElement>\(":scope > a\[href\]"\)/);
  // The sliding class goes on before anything can re-place the pill (the
  // ResizeObserver's first call), so the from-position is the start of a transition.
  assert.ok(SHELL.indexOf('pill.classList.add("sliding")') > 0);
  assert.ok(SHELL.indexOf('pill.classList.add("sliding")') < SHELL.indexOf("resize.observe(nav)"));
  // A client-side page change inside the same layout moves it too.
  assert.match(SHELL, /\}, \[pathname\]\);/);
});

test("a page reached from the dock does not flash its own marker before the pill slides in", () => {
  const attrs = {};
  vm.runInNewContext(THEME_BOOT, {
    localStorage: { getItem: () => null },
    sessionStorage: { getItem: (k) => (k === "nexus-rail-from" ? "/inbox" : null) },
    document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) } },
  });
  assert.equal(attrs["data-rail-from"], "1");
  assert.match(SHELL_CSS, /html\[data-rail-from\] \.deck-root\.shell \.shell-rail:not\(\[data-pill="ready"\]\) a\.on/);
});

test("a risen card can still lift on hover", () => {
  // A forward fill pins the end state above every other style; the end state
  // is the natural one, so the fill only needs to cover the delay.
  for (const name of ["nx-in", "nx-pop-in", "nx-sheet-in"]) {
    const uses = [...MOTION.matchAll(new RegExp(`animation:\\s*${name}\\b[^;]*;`, "g"))].map((m) => m[0]);
    assert.ok(uses.length > 0, `${name} is not used`);
    for (const use of uses) assert.match(use, /\bbackwards\b/, use);
  }
});

test("a dock saved shrunk still fits the phone bar", () => {
  const phone = mediaBlock(SHELL_CSS, "@media (max-width: 860px) {\n  .shell,");
  assert.match(phone, /html\[data-rail="icons"\] \.deck-root \.rail-foot/);
});

test("the inbox keeps the whole screen it was built for", () => {
  // The admin's top bar is everywhere except the inbox, whose own header holds
  // the work; on a phone with a conversation open, the dock steps aside so the
  // composer is not under it.
  assert.match(SHELL, /role === "operator" && !pathname\.startsWith\("\/inbox"\) \? \(/);
  assert.match(SHELL_CSS, /body:has\(\.ibx\.has-thread\) \.deck-root\.shell \.shell-rail\s*\{\s*display:\s*none/);
});

test("no white label sits on a button that turns cream at night", () => {
  const BG = /background(?:-color)?\s*:\s*[^;]*var\(--(signal|signal-text|sky|sky-deep|as-navy|as-signal|btn-grad|sky-grad)\)/;
  const WHITE = /(^|[;{\s])color\s*:\s*(#fff\b|#ffffff\b|white\b)/i;
  const here = fileURLToPath(new URL("../app", import.meta.url));
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".css") ? [join(d, e.name)] : []));
  const offenders = [];
  for (const file of walk(here)) {
    for (const [sel, body] of rules(readFileSync(file, "utf8"))) {
      if (BG.test(body) && WHITE.test(body)) offenders.push(`${file.slice(here.length + 1)}: ${sel}`);
    }
  }
  assert.deepEqual(offenders, []);
  // Hard-coded hovers on surfaces that flip at night, and the undo toast.
  assert.doesNotMatch(read("../app/assistant.css"), /\.as-open:hover\s*\{\s*background:\s*#/);
  assert.doesNotMatch(read("../app/inbox/inbox.css"), /\.ibx-undo button\s*\{[^}]*color:\s*var\(--signal-on-dark\)/);
});

test("staff on phones can mute, without the dock", () => {
  const tools = SHELL.match(/role === "employee" \? \(\s*<div className="shell-phone-tools"[\s\S]*?<\/div>/);
  assert.ok(tools, "no phone tools for staff");
  assert.match(tools[0], /<SoundToggle \/>/);
  assert.match(tools[0], /<ThemeToggle compact \/>/);
  assert.match(SHELL_CSS, /\.shell-phone-tools\s*\{\s*display:\s*none/);
});

test("the theme's circle reveals the whole screen, dock and page included", () => {
  // Specific enough to beat the naming rule (.deck-root.shell .shell-rail).
  assert.match(MOTION, /html\.nx-theme-switch \.deck-root\.shell :is\(\.shell-rail, \.shell-main\)\s*\{\s*view-transition-name:\s*none/);
});
