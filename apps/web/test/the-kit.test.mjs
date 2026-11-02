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
  // Draws in by a sweeping clip (see "a chart's line draws in by a sweep").
  assert.match(html, /<path class="kit-line kit-reveal"/);
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

// ---- Task 4: card into a window, and the slide-in panel ------------------------------------

import { CardWindow } from "@/app/kit/card-window";
import { SlidePanel } from "@/app/kit/slide-panel";
import { nextFocus } from "@/lib/kit/focus";

test("a window is a named dialog with a Close, and renders nothing when shut", () => {
  assert.equal(render(CardWindow, { open: false, title: "Call back", onClose() {}, children: "x" }), "");
  const html = render(CardWindow, { open: true, title: "Call back", onClose() {}, children: "body" });
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Call back"/);
  assert.match(html, /aria-label="Close"/);
  assert.match(html, /body/);
});

test("a panel is a named dialog too", () => {
  assert.match(render(SlidePanel, { open: true, title: "Sara Khan", onClose() {}, children: "p" }), /role="dialog" aria-modal="true" aria-label="Sara Khan"/);
  assert.equal(render(SlidePanel, { open: false, title: "Sara Khan", onClose() {}, children: "p" }), "");
});

test("Tab stays inside, and Escape, focus return and sounds are wired", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
  assert.equal(nextFocus([a, b, c], c, false), a);
  assert.equal(nextFocus([a, b, c], a, true), c);
  assert.equal(nextFocus([a, b, c], null, false), a);
  const W = read("app/kit/card-window.tsx");
  assert.match(W, /"Escape"/);
  assert.match(W, /origin\?\.focus\(\)/);
  assert.match(W, /play\("pop"\)/);
  const P = read("app/kit/slide-panel.tsx");
  assert.match(P, /play\("whoosh"\)/);
  assert.match(P, /"Escape"/);
  // Not part 1's nx-pop / nx-sheet, which play their own sound on top.
  assert.doesNotMatch(W + P, /nx-pop|nx-sheet/);
});

// ---- Task 5: board column, board card and pointer drag -------------------------------------

import { BoardColumn, BoardCard } from "@/app/kit/board";
import { dropTarget } from "@/lib/kit/drag";

test("a column has its tone, name and count, and a card its tone and name", () => {
  const html = render(BoardColumn, { id: "today", tone: "mustard", title: "Today", count: 3, children: "" });
  assert.match(html, /data-column="today"/);
  assert.match(html, /class="kit-col tone-head-mustard/);
  assert.match(html, />3</);
  const card = render(BoardCard, { id: "t1", tone: "terra", title: "Call back", lines: ["Zipicka"], onOpen() {}, label: "Open follow-up: Call back" });
  assert.match(card, /class="kit-card tone-terra/);
  assert.match(card, /aria-label="Open follow-up: Call back"/);
  assert.match(card, /dir="auto"/);
});

test("a drop onto its own column, onto no column, or one the board refuses goes nowhere", () => {
  assert.equal(dropTarget("today", "later", true), "later");
  assert.equal(dropTarget("today", "today", true), null);
  assert.equal(dropTarget("today", null, true), null);
  assert.equal(dropTarget("done", "today", false), null);
});

test("the drag waits for intent, plays the chime only after a saved drop, and Escape cancels", () => {
  const B = read("app/kit/board.tsx");
  assert.match(B, /DRAG_START_PX = 6/);
  assert.match(B, /TOUCH_HOLD_MS = 250/);
  assert.match(B, /dropTarget\(/);
  assert.match(B, /\.then\(\(\) => play\("chime"\)\)/);
  assert.match(B, /\.catch\(/);
  assert.match(B, /"Escape"/);
  // A drag that ends never also opens the card.
  assert.match(B, /suppressClick/);
});

// ---- Found in the browser check (Task 12): the deck's base link rule ------------------------

test("a kit card, pill or button that is a link keeps its own colours inside the deck", () => {
  // `.deck-root a { color: inherit }` outranked the kit's one-class colours, so
  // every toned card that is a link — the waiting cards, a customer's
  // conversations — and the quick-link pills drew ink text on an ink, green or
  // terracotta ground. A base reset must never outrank a component's class.
  const deck = read("app/deck/deck.css");
  assert.doesNotMatch(deck, /^\.deck-root a \{/m);
  assert.match(deck, /^:where\(\.deck-root\) a \{ color: inherit; text-decoration: none; \}/m);
});

test("a board's columns are full-height lanes, so a drop below the last card still lands", () => {
  // Found in the browser (Task 12): columns as tall as their cards made a short
  // column a small target, and letting go just under its last card did nothing.
  const kit = read("app/kit/kit.css");
  assert.match(kit, /\.kit-board \{[^}]*align-items: stretch;/);
});

test("a press is followed by the window, so a flick off the card or a release anywhere ends it", () => {
  // Found in the browser (Task 12): a mouse that left the card before moving
  // 6px on it never started the drag, and its release landed elsewhere — so the
  // press was never let go and the board stopped dragging until a reload.
  const B = read("app/kit/board.tsx");
  for (const type of ["pointermove", "pointerup", "pointercancel"]) {
    assert.ok(B.includes(`window.addEventListener("${type}"`), `the window does not hear ${type}`);
    assert.ok(B.includes(`window.removeEventListener("${type}"`), `the window keeps hearing ${type} after the press`);
  }
  // The card only starts a press; the window hears the rest of it.
  assert.doesNotMatch(B, /onPointerUp\(event\)/);
});

test("the click that ends a drag is swallowed for a moment, wherever the browser sends it", () => {
  // A real drag's click lands on whatever holds both the card and the drop
  // point, never on the card, so a flag waiting for the card's click stayed up
  // and swallowed the next real tap on any card.
  const B = read("app/kit/board.tsx");
  assert.match(B, /Date\.now\(\) < suppressClickUntil\.current/);
  assert.doesNotMatch(B, /suppressClick\.current = true/);
});

test("a window and a panel mount on the console shell, so they cover its rail too", () => {
  // Found in the browser (Task 12): rendered inside the page, the scrim sat in
  // the shell's main column — its own stacking context at z 1 — so the rail
  // (z 3) stayed sharp above every window. They mount on the shell instead,
  // which also carries the tokens and fonts the window needs.
  const W = read("app/kit/card-window.tsx");
  assert.match(W, /export function kitLayer\(\)/);
  assert.match(W, /document\.querySelector<HTMLElement>\("\.deck-root\.shell"\)/);
  assert.match(W, /createPortal\(/);
  const P = read("app/kit/slide-panel.tsx");
  assert.match(P, /kitLayer\(\)/);
  assert.match(P, /createPortal\(/);
});

test("a bar chart's hover label has a kit name of its own, so no page's old .bar can squash it", () => {
  // Found in the browser (Task 12): the label was `kit-tip bar`, and the deck's
  // `.deck-root .bar` (a 6px progress bar, overflow hidden, pale ground) beat
  // it — every bar chart's label in the deck was an invisible pale strip.
  const C = read("app/kit/charts.tsx");
  assert.match(C, /className="kit-tip kit-tip-bar"/);
  assert.doesNotMatch(C, /"kit-tip bar"/);
  assert.match(read("app/kit/kit.css"), /\.kit-tip\.kit-tip-bar \{/);
});

test("on a phone a month of bars keeps them wide enough to see and tap", () => {
  // Found in the browser (Task 12): 30 days at 375px with 6px gaps left 5px bars.
  const kit = read("app/kit/kit.css");
  const phone = kit.slice(kit.indexOf("@media (max-width: 760px)"));
  assert.match(phone, /\.kit-bars-row \{ gap: 2px; \}/);
});

// ---- Final review fixes ---------------------------------------------------------------------

import { visibleBoxes, edgeScroll } from "@/lib/kit/drag";

test("only the part of a column you can see takes a drop", () => {
  // Final review: Done sat off the board's right edge at 1024px, and a release
  // in the window's last pixels dropped onto it — completing a follow-up nobody
  // could see.
  const boxes = [
    { key: "later", left: 700, right: 930, top: 100, bottom: 600 },
    { key: "done", left: 944, right: 1174, top: 100, bottom: 600 },
  ];
  const seen = visibleBoxes(boxes, { left: 200, right: 940, top: 0, bottom: 800 });
  assert.deepEqual(seen.map((b) => b.key), ["later"]);
  assert.equal(columnAt(1000, 300, seen), null);
  // Partly in view: clipped to what shows.
  const half = visibleBoxes(boxes, { left: 200, right: 1000, top: 0, bottom: 800 });
  assert.deepEqual(half.find((b) => b.key === "done"), { key: "done", left: 944, right: 1000, top: 100, bottom: 600 });
  assert.deepEqual(visibleBoxes(boxes, null), boxes);
});

test("near a board's edge a drag scrolls it, faster the closer it gets", () => {
  assert.equal(edgeScroll(500, 200, 940), 0);
  assert.ok(edgeScroll(935, 200, 940) > edgeScroll(900, 200, 940));
  assert.ok(edgeScroll(900, 200, 940) > 0);
  assert.ok(edgeScroll(205, 200, 940) < 0);
  assert.ok(Math.abs(edgeScroll(-50, 200, 940)) <= 18 && edgeScroll(2000, 200, 940) <= 18);
});

test("the dragged card is drawn on the kit's layer, follows from where it started, and the board scrolls under it", () => {
  const B = read("app/kit/board.tsx");
  // Final review: appended to <body>, outside the shell's tokens and fonts, the
  // card lifted as an unstyled, see-through copy.
  assert.match(B, /\(kitLayer\(\) \?\? document\.body\)\.append\(ghost\)/);
  assert.match(B, /visibleBoxes\(/);
  assert.match(B, /edgeScroll\(/);
  assert.match(B, /requestAnimationFrame\(/);
  assert.match(B, /cancelAnimationFrame\(/);
  // The ghost moves from the card's starting place, so a scroll does not drag it away.
  assert.match(B, /p\.startLeft/);
});

import { bandIndex } from "@/lib/kit/chart-math";

test("a chart's line draws in by a sweep, whole at any width", () => {
  // Final review: the dash trick (pathLength 1 + non-scaling stroke, in a
  // stretched 600-unit viewBox) left the newest days undrawn on any chart wider
  // than 600px. The line is revealed by a clip that sweeps across instead.
  const C = read("app/kit/charts.tsx");
  assert.match(C, /<path className="kit-line kit-reveal" d=\{smoothPath\(xy\)\} vectorEffect="non-scaling-stroke" \/>/);
  assert.doesNotMatch(C, /nx-draw kit-line/);
  const kit = read("app/kit/kit.css");
  const motion = kit.slice(kit.indexOf("@media (prefers-reduced-motion: no-preference)"));
  assert.match(motion, /\.kit-reveal \{ animation: kit-reveal/);
  assert.match(motion, /@keyframes kit-reveal \{ from \{ clip-path: inset\(0 100% 0 0\); \}/);
});

test("on a touch screen a chart's label stays after the finger lifts, and follows a sliding finger across bars", () => {
  // Final review: lifting a finger fires pointerleave, which cleared the label
  // at once; and a touch is captured by the bar it started on, so sliding never
  // reached the others. Forecast's figures exist only in that label.
  const C = read("app/kit/charts.tsx");
  assert.equal((C.match(/if \(event\.pointerType === "mouse"\) setActive\(null\);/g) ?? []).length, 2);
  assert.match(C, /const i = bandIndex\(event\.clientX - box\.left, box\.width, bars\.length\);\s*if \(i >= 0\) setActive\(i\);/);
  assert.doesNotMatch(C, /onPointerEnter=\{\(\) => setActive\(i\)\}/);
  // Which bar a point across the chart falls on.
  assert.equal(bandIndex(0, 300, 30), 0);
  assert.equal(bandIndex(15, 300, 30), 1);
  assert.equal(bandIndex(299.9, 300, 30), 29);
  assert.equal(bandIndex(-20, 300, 30), 0);
  assert.equal(bandIndex(400, 300, 30), 29);
  assert.equal(bandIndex(10, 0, 30), -1);
  assert.equal(bandIndex(10, 300, 0), -1);
});

// ---- SFS workflow audit: a bar with no value -------------------------------------------------

import { describeBar as describeAnyBar } from "@/app/kit/charts";

test("a bar with no value is an empty slot, never a zero", () => {
  // A day with no replies has no reply time. Drawn at zero height it would
  // read as an instant answer, so it is an empty, outlined slot that says so.
  const html = render(BarChart, { bars: [{ label: "Mon", value: 4 }, { label: "Tue", value: null }], ariaLabel: "Reply time", emptyLabel: "no replies" });
  assert.equal((html.match(/class="kit-bar-empty"/g) ?? []).length, 1);
  assert.equal((html.match(/class="kit-bar nx-grow"/g) ?? []).length, 1);
  assert.equal(describeAnyBar({ label: "Tue", value: null }, String, undefined, "no replies"), "Tue: no replies");
  assert.doesNotMatch(html, /NaN/);
  assert.match(read("app/kit/kit.css"), /\.kit-bar-empty \{/);
  // Every bar empty: nothing to draw, said as such.
  assert.match(render(BarChart, { bars: [{ label: "Mon", value: null }], ariaLabel: "Reply time" }), /Not enough days yet to draw a line\./);
});
