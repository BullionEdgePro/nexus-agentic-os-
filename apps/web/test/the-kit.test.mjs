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

// ---- Task 2: number tile and status card --------------------------------------------------

import { NumberTile } from "@/app/kit/number-tile";
import { StatusCard } from "@/app/kit/status-card";

test("a number tile shows its figure ready to count up, with its note", () => {
  const html = render(NumberTile, { label: "Messages today", value: "1,240", note: "since midnight" });
  assert.match(html, /class="kit-tile"/);
  assert.match(html, /<span data-countup="">1,240<\/span>/);
  assert.match(html, /since midnight/);
  assert.doesNotMatch(html, /<path/, "no sparkline without real points");
  assert.match(render(NumberTile, { label: "x", value: "1", spark: [1, 4, 2] }), /class="kit-spark nx-draw"[^>]*pathLength="1"/);
});

test("a status card takes its tone, links when it has somewhere to go, and keeps long names on one line", () => {
  const html = render(StatusCard, { tone: "terra", title: "عبد الله الهاشمي ".repeat(4), subtitle: "SFS International", figure: "3 h 12 m", href: "/inbox?conversation=1" });
  assert.match(html, /^<a [^>]*class="kit-card tone-terra/);
  assert.match(html, /href="\/inbox\?conversation=1"/);
  assert.match(html, /dir="auto"/);
  const css = read("app/kit/kit.css");
  assert.match(css, /\.kit-card-title \{[^}]*text-overflow: ellipsis/);
  for (const tone of ["mustard", "forest", "terra", "ink"]) {
    assert.match(css, new RegExp(`\\.tone-${tone} \\{[^}]*background: var\\(--st-${tone}\\);[^}]*color: var\\(--on-${tone}\\);`));
  }
  assert.doesNotMatch(css, /rgba\(0,\s*0,\s*0/);
});

test("a card that opens is a button with a name", () => {
  const html = render(StatusCard, { tone: "mustard", title: "Call back", onOpen: () => {}, label: "Open follow-up: Call back" });
  assert.match(html, /^<button type="button" [^>]*aria-label="Open follow-up: Call back"/);
});

test("the kit moves only when motion is welcome", () => {
  const css = read("app/kit/kit.css");
  const at = css.indexOf("@media (prefers-reduced-motion: no-preference)");
  assert.ok(at > 0);
  assert.doesNotMatch(css.slice(0, at), /animation:|transition:/);
});

// ---- Task 3: chart card and charts ---------------------------------------------------------

import { ChartCard } from "@/app/kit/chart-card";
import { AreaChart, BarChart } from "@/app/kit/charts";

const days = [3, 5, 4, 8].map((value, i) => ({ label: `Day ${i + 1}`, value }));

test("an area chart draws a line that draws in, and can be read by keyboard", () => {
  const html = render(AreaChart, { points: days, ariaLabel: "Conversations per day" });
  assert.match(html, /role="img" aria-label="Conversations per day"/);
  assert.match(html, /class="nx-draw[^"]*"[^>]*pathLength="1"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /NaN/);
});

test("too little history says so instead of drawing", () => {
  for (const points of [[], [{ label: "Today", value: 4 }]]) {
    const html = render(AreaChart, { points, ariaLabel: "x" });
    assert.match(html, /Not enough days yet to draw a line\./);
    assert.doesNotMatch(html, /<path/);
  }
  const flat = render(AreaChart, { points: [{ label: "a", value: 0 }, { label: "b", value: 0 }], ariaLabel: "x" });
  assert.match(flat, /<path/);
  assert.doesNotMatch(flat, /NaN/);
});

test("bars grow, a part is shaded, a range has its band and mid mark", () => {
  const html = render(BarChart, { bars: [{ label: "Mon", value: 10, part: 3 }, { label: "Tue", value: 6, low: 4, high: 9 }], ariaLabel: "Daily" });
  assert.match(html, /class="kit-bar nx-grow"/);
  assert.match(html, /class="kit-bar-part"/);
  assert.match(html, /class="kit-bar-range"/);
  assert.match(html, /class="kit-bar-mid"/);
  assert.match(render(BarChart, { bars: [], ariaLabel: "Daily" }), /Not enough days yet to draw a line\./);
});

test("a chart card has its title and big figure", () => {
  const html = render(ChartCard, { title: "Conversations", figure: "126", children: "chart" });
  assert.match(html, /<h3[^>]*>Conversations<\/h3>/);
  assert.match(html, /<span data-countup="">126<\/span>/);
});
