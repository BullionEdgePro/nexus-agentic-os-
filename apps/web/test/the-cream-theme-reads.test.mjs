/**
 * The Cream theme (spec 2026-11-01-cream-foundation-design.md §1).
 *
 * The values are the owner's chosen look, so they are pinned exactly. The
 * contrast pairs are the reason those values were chosen: every one of them
 * carries text, and a token edit that drops one below 4.5:1 must fail here
 * rather than on a customer's screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const deck = read("../app/deck/deck.css");

/** The body of the rule that starts at `head`, braces matched. */
function block(css, head) {
  const at = css.indexOf(head);
  assert.ok(at >= 0, `missing rule: ${head}`);
  let depth = 0;
  for (let i = css.indexOf("{", at); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", at) + 1, i);
  }
  throw new Error(`unclosed rule: ${head}`);
}

function tokens(body) {
  const out = {};
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

const light = tokens(block(deck, "\n.deck-root {"));
const dark = { ...light, ...tokens(block(deck, 'html[data-theme="dark"] .deck-root:not(.pl-root) {')) };

function lum(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4]
    .map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
function contrast(a, b) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const LIGHT = {
  "--marble": "#F3EFE8", "--paper": "#FFFEFB", "--pebble": "#ECE6DB", "--charcoal": "#16140F", "--charcoal-card": "#24211B",
  "--ink": "#16140F", "--slate": "#5B5549", "--mist": "#6B6357", "--hairline": "#E6DFD3", "--hairline-strong": "#D6CDBE",
  "--signal": "#16140F", "--signal-text": "#2F5D50", "--sky": "#2F5D50", "--sky-deep": "#24493F", "--sky-soft": "#E7EFEA",
  "--on-accent": "#F3EFE8", "--good": "#2B6B4A", "--warn": "#875400", "--crit": "#B42318",
  "--st-mustard": "#E8C24A", "--on-mustard": "#16140F", "--st-forest": "#2F5D50", "--on-forest": "#FFFFFF",
  "--st-terra": "#B4532C", "--on-terra": "#FFFFFF", "--st-ink": "#16140F", "--on-ink": "#F3EFE8",
  "--r": "22px", "--r-lg": "28px", "--r-sm": "12px",
};
const DARK = {
  "--marble": "#14120E", "--paper": "#1D1A15", "--pebble": "#27231C", "--charcoal": "#0D0C09", "--ink": "#F3EFE8",
  "--slate": "#C9C1B3", "--mist": "#A69E90", "--signal-text": "#8CC4AE",
  "--st-mustard": "#EBC75A", "--st-forest": "#6FA892", "--st-terra": "#E0835A",
  "--on-mustard": "#14120E", "--on-forest": "#14120E", "--on-terra": "#14120E",
  "--good": "#7CC79E", "--warn": "#E9B65C", "--crit": "#FF8A7A",
};

test("Cream is the light theme, value for value", () => {
  for (const [name, value] of Object.entries(LIGHT)) {
    assert.equal(light[name]?.toLowerCase(), value.toLowerCase(), name);
  }
  assert.match(light["--sky-wash"] ?? "", /^rgba\(47,\s*93,\s*80,\s*\.?0?\.08\)$/);
});

test("Warm Night is the dark theme, value for value", () => {
  for (const [name, value] of Object.entries(DARK)) {
    assert.equal(dark[name]?.toLowerCase(), value.toLowerCase(), name);
  }
});

const PAIRS = [
  ["--ink", "--marble"], ["--ink", "--paper"], ["--slate", "--pebble"], ["--mist", "--pebble"],
  ["--signal-text", "--pebble"], ["--crit", "--pebble"], ["--good", "--pebble"], ["--warn", "--pebble"],
  ["--on-mustard", "--st-mustard"], ["--on-forest", "--st-forest"], ["--on-terra", "--st-terra"], ["--on-ink", "--st-ink"],
];

test("every text colour reads on its ground in both themes", () => {
  for (const [theme, t] of [["light", light], ["dark", dark]]) {
    for (const [fg, bg] of PAIRS) {
      const ratio = contrast(t[fg], t[bg]);
      assert.ok(ratio >= 4.5, `${theme} ${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  }
  // White-on-black buttons: the words on the pill.
  assert.ok(contrast(light["--on-accent"], light["--signal"]) >= 4.5);
});

test("the storefront takes the console's Cream tokens", () => {
  const lp = tokens(block(read("../app/landing.css"), ".deck-root.lp {"));
  for (const own of ["--marble", "--paper", "--ink", "--signal", "--sky"]) assert.equal(lp[own], undefined, own);
});

test("the phone's status bar takes the dock's near-black", () => {
  assert.match(read("../app/layout.tsx"), /themeColor: "#16140F"/);
});

test("page titles are the video's big, tight two-liners", () => {
  const rules = [...deck.matchAll(/([^{}]*page-head h1[^{}]*)\{([^}]*)\}/g)];
  assert.ok(rules.length > 0, "no page-head h1 rule");
  const main = rules.find(([, sel]) => sel.trim() === ".deck-root .page-head h1");
  assert.ok(main, "no .deck-root .page-head h1 rule");
  assert.match(main[2], /font-size:\s*clamp\(30px,\s*3\.2vw,\s*44px\)/);
  assert.match(main[2], /letter-spacing:\s*-0\.025em/);
  assert.match(main[2], /line-height:\s*1\.02/);
  for (const [, sel, body] of rules) {
    const size = body.match(/font-size:\s*([^;]+)/);
    if (size) assert.equal(size[1].trim(), "clamp(30px, 3.2vw, 44px)", `${sel.trim()} sets its own title size`);
  }
});
