/**
 * The screens that pick up the kit in part 1 (spec
 * 2026-11-01-cream-foundation-design.md §3–4): the admin front page's figures
 * count up and its lines draw; My Day's counts count up; search, shortcuts and
 * Ask a colleague grow out of the click; the assistant slides in; a bulk send
 * chimes; a new chat or team message pings.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the front page's figures count up and its lines draw", () => {
  const deck = read("../app/deck-console.tsx");
  // Since Cream pages 2a the tiles and the chart are the kit's, which count up
  // and draw (the-kit.test.mjs renders both).
  assert.match(deck, /<NumberTile key=\{s\.k\} label=\{s\.k\} value=\{s\.v\}/);
  assert.match(deck, /<AreaChart points=\{days\}/);
  assert.match(read("../app/kit/number-tile.tsx"), /<span data-countup="">\{value\}<\/span>/);
  // A drawn line needs pathLength="1" so one dash spans it (motion.css) — the
  // sparkline, in its fixed box. The chart's line stretches with its card, where
  // a dash cannot span it, so it draws in by a sweeping clip instead
  // (the-kit.test.mjs, "a chart's line draws in by a sweep").
  assert.match(read("../app/kit/charts.tsx"), /className="kit-line kit-reveal"/);
  assert.match(read("../app/kit/number-tile.tsx"), /className="kit-spark nx-draw"[^>]*pathLength="1"/);
});

test("My Day's counts count up", () => {
  const day = read("../app/my-day.tsx");
  assert.equal((day.match(/<dd[^>]*data-countup/g) ?? []).length, 3);
});

test("pop-up windows grow out of the click, over a frosted page", () => {
  const palette = read("../app/command-palette.tsx");
  assert.match(palette, /className="cmdp-backdrop nx-pop-backdrop"/);
  assert.match(palette, /className="cmdp nx-pop" role="dialog"/);
  const keys = read("../app/inbox/shortcuts.tsx");
  assert.match(keys, /className="ibx-keys-backdrop nx-pop-backdrop"/);
  assert.match(keys, /className="ibx-keys nx-pop" role="dialog"/);
  assert.match(read("../app/inbox/ask-colleague.tsx"), /className="ibx-ask-pop nx-pop" role="dialog"/);
});

test("the assistant slides in from the side", () => {
  assert.match(read("../app/assistant.tsx"), /<aside className="as nx-sheet"/);
});

test("a bulk send that went out chimes", () => {
  const bulk = read("../app/deck/bulk/page.tsx");
  assert.match(bulk, /import \{ play \} from "@\/lib\/sound";/);
  assert.match(bulk, /play\("chime"\);\s*\n\s*setResult\(\{ ok: true/);
});

test("a new chat for you, or a team message, pings", () => {
  for (const file of ["../app/assignment-alerts.tsx", "../app/team-chat-alerts.tsx"]) {
    const source = read(file);
    assert.match(source, /import \{ play \} from "@\/lib\/sound";/);
    assert.match(source, /play\("ping"\)/);
  }
});
