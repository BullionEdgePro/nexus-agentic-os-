/**
 * Colours that bypassed the tokens (spec 2026-11-01-cream-foundation-design.md
 * §1, "Files with their own colours").
 *
 * A literal blue in a screen's own stylesheet is a screen that stays blue when
 * the theme turns cream — the one patch of the old look left on a page. Each
 * file below wrote its own; this keeps them on the tokens. Channel colours
 * (WhatsApp green, Facebook blue, Instagram pink) are brands, not theme, and
 * are allowed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/** deck.css without its two token blocks — those are checked by the theme test. */
function deckOutsideTokens() {
  let css = read("../app/deck/deck.css");
  for (const head of ["\n.deck-root {", 'html[data-theme="dark"] .deck-root:not(.pl-root) {']) {
    const at = css.indexOf(head);
    const end = css.indexOf("\n}", at);
    css = css.slice(0, at) + css.slice(end + 2);
  }
  return css;
}

// Calm and Night Sky blues, and the navy their shadows were tinted with.
const BLUE_HEX = /#(3b82f6|2563eb|1d4ed8|1e3a8a|0873c9|065fa8|0b2a4a|44678a|f3f8fd|e8f2fc|d6e7f6|123f66|a9c4de|eef2fb|93b4ff|dff0ff|0b5fa5|4fbcff|86cdff|9ad7ff|1486e0|0a1422|101d2e|172739|1e3247|a3b8ce|e4eef9)\b/i;
const BLUE_RGBA = /rgba?\(\s*(59\s*,\s*130\s*,\s*246|37\s*,\s*99\s*,\s*235|29\s*,\s*78\s*,\s*216|94\s*,\s*196\s*,\s*255|63\s*,\s*178\s*,\s*255|11\s*,\s*42\s*,\s*74|11\s*,\s*53\s*,\s*88|79\s*,\s*188\s*,\s*255|16\s*,\s*29\s*,\s*46)/;
// The Calm severity colours, now --good / --warn / --crit.
const OLD_SEVERITY = /rgba?\(\s*(196\s*,\s*52\s*,\s*42|15\s*,\s*122\s*,\s*86|156\s*,\s*93\s*,\s*15)/;

const FILES = {
  "app/inbox/inbox.css": () => read("../app/inbox/inbox.css"),
  "app/assistant.css": () => read("../app/assistant.css"),
  "app/command-palette.css": () => read("../app/command-palette.css"),
  "app/console-shell.css": () => read("../app/console-shell.css"),
  "app/deck/my-clients/my-clients.css": () => read("../app/deck/my-clients/my-clients.css"),
  "app/deck/links/links.css": () => read("../app/deck/links/links.css"),
  "app/deck/team/team.css": () => read("../app/deck/team/team.css"),
  "app/deck/deck.css (outside the tokens)": deckOutsideTokens,
};

for (const [name, load] of Object.entries(FILES)) {
  test(`${name} draws no old blue of its own`, () => {
    const css = load();
    const hex = css.match(BLUE_HEX);
    assert.equal(hex, null, `${name} still has ${hex?.[0]}`);
    const rgba = css.match(BLUE_RGBA);
    assert.equal(rgba, null, `${name} still has ${rgba?.[0]}`);
    const sev = css.match(OLD_SEVERITY);
    assert.equal(sev, null, `${name} still has the old severity colour ${sev?.[0]}`);
  });
}
