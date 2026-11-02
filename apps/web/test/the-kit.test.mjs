/**
 * The kit (2 Nov 2026, Cream pages part 2a): the six shared pieces every
 * dashboard page is built from — number tile, status card, chart card, board
 * column and card, card into a window, slide-in panel — and the pure logic
 * under them. Spec: docs/superpowers/specs/2026-11-02-cream-pages-2a-design.md
 *
 * The pieces are tested by what they draw (rendered with react-dom/server), and
 * the logic directly; a test that only searched the source would pass on code
 * that never runs, which is how a staff chat bug reached the final review.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { scaleLinear, niceMax, smoothPath, areaPath, nearestIndex } from "@/lib/kit/chart-math";
import { columnAt, orderAfterDrop } from "@/lib/kit/drag";
import { waitTone, formatWait } from "@/lib/kit/wait-band";
import { originOf } from "@/lib/kit/place";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

// ---- Task 1: the kit's pure logic ---------------------------------------------------------

test("scales map, and a flat domain never divides by zero", () => {
  const y = scaleLinear([0, 10], [100, 0]);
  assert.equal(y(5), 50);
  assert.equal(scaleLinear([3, 3], [100, 0])(3), 100);
  assert.deepEqual([0, 7, 10, 23, 180, 999].map(niceMax), [1, 10, 10, 25, 200, 1000]);
});

test("a smooth line starts and ends on the data, and empty or single series draw nothing broken", () => {
  const d = smoothPath([[0, 10], [50, 0], [100, 30]]);
  assert.match(d, /^M0 10 C/);
  assert.match(d, /100 30$/);
  assert.equal(smoothPath([]), "");
  assert.equal(smoothPath([[4, 5]]), "M4 5");
  assert.doesNotMatch(smoothPath([[0, 0], [10, 0], [20, 0]]), /NaN/);
  assert.match(areaPath([[0, 10], [100, 30]], 120), /L100 120 L0 120 Z$/);
});

test("the hover label goes to the nearest point", () => {
  assert.equal(nearestIndex([0, 50, 100], 70), 1);
  assert.equal(nearestIndex([0, 50, 100], 80), 2);
  assert.equal(nearestIndex([], 5), -1);
});

test("a drag knows which column it is over, and a drop reorders", () => {
  const boxes = [
    { key: "overdue", left: 0, right: 100, top: 0, bottom: 500 },
    { key: "today", left: 110, right: 210, top: 0, bottom: 500 },
  ];
  assert.equal(columnAt(150, 40, boxes), "today");
  assert.equal(columnAt(105, 40, boxes), null);
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.deepEqual(orderAfterDrop(cards, "a", 2).map((c) => c.id), ["b", "c", "a"]);
});

test("a wait takes its colour by length, at each edge", () => {
  const min = 60_000;
  assert.equal(waitTone(29 * min), "forest");
  assert.equal(waitTone(30 * min), "mustard");
  assert.equal(waitTone(120 * min - 1), "mustard");
  assert.equal(waitTone(120 * min), "terra");
  assert.equal(waitTone(24 * 60 * min), "ink");
  assert.equal(formatWait(30_000), "under a minute");
  assert.equal(formatWait(12 * min), "12 m");
  assert.equal(formatWait(192 * min), "3 h 12 m");
  assert.equal(formatWait((2 * 24 + 4) * 60 * min), "2 d 4 h");
});

test("a window grows from the card it opens", () => {
  assert.deepEqual(originOf({ left: 100, top: 50, width: 200, height: 100 }, { width: 1000, height: 1000 }), { x: 20, y: 10 });
  assert.deepEqual(originOf({ left: 990, top: -50, width: 100, height: 20 }, { width: 1000, height: 1000 }), { x: 100, y: 0 });
});
