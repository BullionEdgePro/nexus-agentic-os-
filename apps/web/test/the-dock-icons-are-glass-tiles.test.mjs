/**
 * The dock's icons as glass tiles (1 Nov 2026, the owner's choice: a colour
 * per section). Each icon sits in a small rounded glass tile like an iPhone
 * home-screen app, coloured by its section, so a section is found by colour
 * before its name is read: Home mustard, Work forest, People terracotta, Grow
 * cream, AI agent plum, Insights teal, Admin graphite, You rose.
 *
 * The colour comes from the section list itself (lib/nav.tsx), so a screen
 * moved to another section changes colour with it, and a new section without
 * a colour fails here rather than turning up grey.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { NAV, NAV_GROUPS, toneOf } from "@/lib/nav";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const CSS = read("../app/console-shell.css");

const slug = (title) => title.toLowerCase().replace(/\s+/g, "-");

test("each screen takes its section's colour", () => {
  assert.equal(toneOf("/"), "home");
  assert.equal(toneOf("/inbox"), "home");
  assert.equal(toneOf("/deck/tasks"), "work");
  assert.equal(toneOf("/deck/customers"), "people");
  assert.equal(toneOf("/deck/bulk"), "grow");
  assert.equal(toneOf("/deck/agent"), "ai-agent");
  assert.equal(toneOf("/deck/forecast"), "insights");
  assert.equal(toneOf("/deck/hq"), "admin");
  assert.equal(toneOf("/deck/my-settings"), "you");
  assert.equal(toneOf("/somewhere-new"), "other");
});

/** --tile-a, --tile-b and --tile-ink for one tone, from the stylesheet. */
function tile(tone) {
  const m = new RegExp(`\\.rail-icon\\[data-tone="${tone}"\\]\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(m, `no glass tile for the ${tone} section`);
  const get = (name) => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, "i").exec(m[1])?.[1];
  const t = { a: get("--tile-a"), b: get("--tile-b"), ink: get("--tile-ink") };
  assert.ok(t.a && t.b && t.ink, `${tone} tile is missing a colour`);
  return t;
}

function lum(hex) {
  return [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

test("every section has a tile, and its icon stands out on both ends of the glass", () => {
  // 3:1 is the bar for a meaningful graphic (WCAG 1.4.11); checked against the
  // light top and the deep bottom of the tile's gradient.
  for (const tone of [...NAV_GROUPS.map((g) => slug(g.title)), "other"]) {
    const t = tile(tone);
    for (const end of [t.a, t.b]) {
      const ratio = contrast(t.ink, end);
      assert.ok(ratio >= 3, `${tone}: icon ${t.ink} on ${end} is ${ratio.toFixed(2)}:1`);
    }
  }
});

test("the dock and the staff phone tabs both draw their icons as tiles", () => {
  const shell = read("../app/console-shell.tsx");
  assert.match(shell, /<span className="rail-icon" data-tone=\{toneOf\(item\.href\)\}>/);
  const tabs = read("../app/mobile-tabs.tsx");
  assert.match(tabs, /data-tone=\{toneOf\(tab\.href\)\}/);
  assert.match(read("../app/mobile-tabs.css"), /\.mtabs \.rail-icon/);
});

test("every screen in the dock is in a section, so none is left grey", () => {
  const grouped = new Set(NAV_GROUPS.flatMap((g) => g.hrefs));
  for (const item of NAV) assert.ok(grouped.has(item.href), `${item.href} has no section`);
});
