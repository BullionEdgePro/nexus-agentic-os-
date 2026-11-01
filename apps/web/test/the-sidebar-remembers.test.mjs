/**
 * The dark dock (spec 2026-11-01-cream-foundation-design.md §2).
 *
 * The dock remembers two things: whether this browser keeps it shrunk to
 * icons, applied before the first paint so the page never jumps; and the page
 * just left, so the pill can slide from there. Storage that throws — private
 * mode, blocked site data — must leave the dock in its default, never break
 * the page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

import { THEME_BOOT } from "@/lib/theme";
import { RAIL_KEY, RAIL_FROM_KEY, readRailMode } from "@/lib/rail";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Runs the before-paint script against a fake page; returns <html>'s attributes. */
function boot(getItem) {
  const attrs = {};
  const context = {
    localStorage: { getItem },
    document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) } },
  };
  vm.runInNewContext(THEME_BOOT, context);
  return attrs;
}

test("the keys are the ones the spec names", () => {
  assert.equal(RAIL_KEY, "nexus-rail");
  assert.equal(RAIL_FROM_KEY, "nexus-rail-from");
});

test("a shrunk dock is applied before the first paint", () => {
  assert.equal(boot((k) => (k === RAIL_KEY ? "icons" : null))["data-rail"], "icons");
});

test("with nothing saved, the dock opens full", () => {
  assert.equal(boot(() => null)["data-rail"], undefined);
});

test("the theme is still applied alongside", () => {
  const attrs = boot((k) => (k === "nexus-theme" ? "dark" : k === RAIL_KEY ? "icons" : null));
  assert.equal(attrs["data-theme"], "dark");
  assert.equal(attrs["data-rail"], "icons");
});

test("storage that throws leaves both defaults and no error", () => {
  let attrs;
  assert.doesNotThrow(() => {
    attrs = boot(() => {
      throw new Error("blocked");
    });
  });
  assert.deepEqual(attrs, {});
});

test("only 'icons' shrinks the dock", () => {
  assert.equal(readRailMode(() => "icons"), "icons");
  assert.equal(readRailMode(() => "full"), "full");
  assert.equal(readRailMode(() => "x"), "full");
  assert.equal(readRailMode(() => null), "full");
  assert.equal(
    readRailMode(() => {
      throw new Error("blocked");
    }),
    "full"
  );
});

test("the dock has its sliding pill, its shrink button and its foot controls", () => {
  const shell = read("../app/console-shell.tsx");
  assert.match(shell, /rail-pill/);
  assert.match(shell, /RAIL_FROM_KEY/);
  assert.match(shell, /rail-collapse/);
  const foot = shell.match(/<div className="rail-foot">[\s\S]*?\n      <\/div>/);
  assert.ok(foot, "no rail-foot");
  assert.match(foot[0], /<ThemeToggle compact \/>/);
  assert.match(foot[0], /<SoundToggle \/>/);
  assert.match(foot[0], /\/api\/auth\/logout/);
});

test("flipping the theme ticks", () => {
  assert.match(read("../app/theme-toggle.tsx"), /play\("tick"\)/);
});

test("the dock shrinks by a root attribute and clears the phone's home bar", () => {
  const css = read("../app/console-shell.css");
  assert.match(css, /html\[data-rail="icons"\]/);
  assert.match(css, /env\(safe-area-inset-bottom\)/);
  assert.match(css, /\.rail-pill\s*\{/);
});
