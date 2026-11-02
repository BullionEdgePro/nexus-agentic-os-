# Cream pages part 2a — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six shared pieces (number tile, status card, chart card, board column/card, card-into-window, slide-in panel) and the six video pages built on them: the admin front page, the Workspace board, Customers, Forecast, Agent quality and the Business HQ overview.

**Architecture:** Pure logic (chart maths, drag targeting, wait bands, placement) in `apps/web/lib/kit/` with no DOM; React pieces in `apps/web/app/kit/` with one stylesheet `kit.css` that reads only part 1's tokens; pages swap their own markup for the pieces and keep their data code and their tested rules. Two additive server fields feed the front page.

**Tech Stack:** Next.js 14, React 18, plain CSS on `.deck-root` tokens, SVG charts, Pointer Events, View Transitions (with a fallback), node:test with `react-dom/server` render tests; Hono + Postgres for the two server fields. No new npm dependency.

**Spec:** `docs/superpowers/specs/2026-11-02-cream-pages-2a-design.md`

## Global Constraints

- Branch `cream-pages-2a` (from `main` at a9f6fc3). Commits stay local until the owner reviews and says "Deploy it". End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- No new npm dependency (web or API, dev included).
- No invented data. A chart with fewer than two real points shows the note "Not enough days yet to draw a line." instead of a line; no sparkline without real points; no change percentages that are not computed from real values.
- Colours only from `.deck-root` tokens; tones are exactly `mustard | forest | terra | ink | paper`, mapped to `--st-mustard/--on-mustard`, `--st-forest/--on-forest`, `--st-terra/--on-terra`, `--st-ink/--on-ink`, `--paper/--ink`. No `rgba(0,0,0,…)`. No custom property read in CSS that nothing defines (guardrail test).
- Motion only inside `@media (prefers-reduced-motion: no-preference)`. Reuse part 1: `data-countup`, `.nx-draw` (with `pathLength="1"`), `.nx-grow`, `.nx-pop`, stagger.
- Sounds via `play()` from `@/lib/sound`: `pop` when a card opens into a window, `whoosh` when a panel slides in, `chime` on a successful board drop.
- Wait tones: under 30 min forest; 30 min to under 2 h mustard; 2 h to under 24 h terra; 24 h and over ink.
- Board column tones: overdue terra, today mustard, later forest, done ink. Conversation-state tones: open forest, pending mustard, resolved and closed ink.
- Existing guard tests read these pages' sources (API suite: copy such as Forecast's refusals, Customers' admin-only export, the board's column rules). Every task ends with the WHOLE web suite and the WHOLE API suite green except the known Windows-only "mirror.sh is itself executable".
- Copy, verbatim: "Not enough days yet to draw a line.", "Nobody is waiting.", "+N more waiting" (N the number), "Move to", "Mark done", "Open chat", "This follow-up is gone."

## Review Focus

1. **An empty, one-point or all-zero series** (a new business, the first day) draws no broken path (no `NaN`, no divide-by-zero) and shows the "Not enough days yet" note; an all-zero series draws a flat line at the bottom.
2. **A drop the server refuses** (offline, 409) puts the card back where it was, shows the error, and makes no second request; a drop onto the card's own column sends nothing.
3. **Long and right-to-left names** (a 60-character follow-up title, an Arabic customer name) never push a card or tile wider than its column: one line with an ellipsis, `dir="auto"` on user text.
4. **The thing a window shows disappears underneath it** (a follow-up completed by a colleague while its window is open, the board reloading): the window shows "This follow-up is gone." with a Close, instead of acting on stale data.
5. **Keyboard only:** Enter opens a card's window, Tab stays inside it, Escape closes it and focus returns to the card; Move to works without a mouse.

Each has its test in the task that owns the code: 1 → Tasks 1 and 3, 2 → Tasks 5 and 8, 3 → Task 2, 4 → Task 8, 5 → Task 4.

---

### Task 1: The kit's pure logic

**Files:**
- Create: `apps/web/lib/kit/chart-math.ts`, `apps/web/lib/kit/drag.ts`, `apps/web/lib/kit/wait-band.ts`, `apps/web/lib/kit/place.ts`
- Test: `apps/web/test/the-kit.test.mjs` (new; Task 1 section)

**Interfaces:**
- Produces (`chart-math.ts`): `scaleLinear(domain: [number, number], range: [number, number]): (v: number) => number` (a zero-width domain maps everything to the range's start); `niceMax(max: number): number` (1, 2, 2.5 or 5 × 10ⁿ at or above max; 0 → 1); `smoothPath(points: Array<[number, number]>): string` (Catmull-Rom as cubic Béziers; 0 points → "", 1 point → `M x y`); `areaPath(points: Array<[number, number]>, baseline: number): string`; `nearestIndex(xs: number[], x: number): number` (−1 for an empty list).
- Produces (`drag.ts`): `type Box = { key: string; left: number; right: number; top: number; bottom: number }`; `columnAt(x: number, y: number, boxes: Box[]): string | null`; `orderAfterDrop<T extends { id: string }>(cards: T[], id: string, toIndex: number): T[]`.
- Produces (`wait-band.ts`): `type Tone = "mustard" | "forest" | "terra" | "ink" | "paper"`; `waitTone(ms: number): Tone`; `formatWait(ms: number): string` ("under a minute", "12 m", "3 h 12 m", "2 d 4 h").
- Produces (`place.ts`): `originOf(rect: { left: number; top: number; width: number; height: number }, viewport: { width: number; height: number }): { x: number; y: number }` — the card's centre in percent of the viewport, clamped 0–100, for the window's transform-origin fallback.

- [ ] **Step 1: Write the failing tests**

```js
import { scaleLinear, niceMax, smoothPath, areaPath, nearestIndex } from "@/lib/kit/chart-math";
import { columnAt, orderAfterDrop } from "@/lib/kit/drag";
import { waitTone, formatWait } from "@/lib/kit/wait-band";
import { originOf } from "@/lib/kit/place";

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
```

- [ ] **Step 2: Run** `npm --prefix apps/web test` — Expected: the new file FAILS (modules missing).
- [ ] **Step 3: Implement** the four modules.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Kit: chart maths, drag targeting, wait colours and window origin"`

---

### Task 2: NumberTile, StatusCard and kit.css

**Files:**
- Create: `apps/web/app/kit/kit.css`, `apps/web/app/kit/number-tile.tsx`, `apps/web/app/kit/status-card.tsx`, `apps/web/app/kit/index.ts` (re-exports)
- Test: `apps/web/test/the-kit.test.mjs` (Task 2 section)

**Interfaces:**
- Consumes: Task 1 `Tone`.
- Produces: `NumberTile({ label, value, unit, note, icon }: { label: string; value: string; unit?: string; note?: string; icon?: string /* an SVG path d */ })` → `<div class="kit-tile">` with the figure in `<span data-countup>`; `StatusCard({ tone, title, subtitle, figure, footer, href, onOpen, label, transitionName }: { tone: Tone; title: string; subtitle?: string; figure?: string; footer?: ReactNode; href?: string; onOpen?: (el: HTMLElement) => void; label?: string; transitionName?: string })` → an `<a>` when `href`, a `<button>` when `onOpen`, else a `<div>`; class `kit-card tone-<tone>`; user text in elements with `dir="auto"`.

- [ ] **Step 1: Write the failing tests** (render with `renderToStaticMarkup(createElement(...))`)

```js
test("a number tile shows its figure ready to count up, with its note", () => {
  const html = render(NumberTile, { label: "Messages today", value: "1,240", note: "since midnight" });
  assert.match(html, /class="kit-tile"/);
  assert.match(html, /<span data-countup="">1,240<\/span>/);
  assert.match(html, /since midnight/);
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
```

- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement.** **Step 4: Run** — Expected: PASS, then both full suites. **Step 5: Commit** — `"Kit: number tile and status card"`

---

### Task 3: ChartCard, AreaChart, LineChart, BarChart

**Files:**
- Create: `apps/web/app/kit/chart-card.tsx`, `apps/web/app/kit/charts.tsx`
- Modify: `apps/web/app/kit/kit.css`, `apps/web/app/kit/index.ts`
- Test: `apps/web/test/the-kit.test.mjs` (Task 3 section)

**Interfaces:**
- Consumes: Task 1 chart maths.
- Produces: `ChartCard({ title, figure, note, periods, period, onPeriod, children })`; `type Point = { label: string; value: number }`; `AreaChart({ points, ariaLabel, format })` and `LineChart({ points, ariaLabel, format })` (`format?: (n: number) => string`); `type Bar = { label: string; value: number; part?: number; low?: number; high?: number }`; `BarChart({ bars, ariaLabel, format, partLabel })` — `part` draws the share of the bar in terra (stacked); `low`/`high` draw a range band with a mid mark at `value`. Every chart: an `<svg role="img" aria-label=…>` inside a focusable wrapper (`tabIndex=0`, `aria-describedby` a visually hidden live region holding "<label>: <value>"); pointer move and ←/→ set the active index (`nearestIndex`); the hover label is an ink pill positioned over the active point. Fewer than two points (area/line) or no bars → the note "Not enough days yet to draw a line." and no `<path>`.

- [ ] **Step 1: Write the failing tests**

```js
const days = [3, 5, 4, 8].map((value, i) => ({ label: `Day ${i + 1}`, value }));
test("an area chart draws a line that draws in, and can be read by keyboard", () => {
  const html = render(AreaChart, { points: days, ariaLabel: "Conversations per day" });
  assert.match(html, /role="img" aria-label="Conversations per day"/);
  assert.match(html, /class="nx-draw[^"]*"[^>]*pathLength="1"/);
  assert.match(html, /tabindex="0"/);
  assert.doesNotMatch(html, /NaN/);
});
test("too little history says so instead of drawing", () => {
  for (const points of [[], [{ label: "Today", value: 4 }]]) {
    const html = render(AreaChart, { points, ariaLabel: "x" });
    assert.match(html, /Not enough days yet to draw a line\./);
    assert.doesNotMatch(html, /<path/);
  }
});
test("bars grow, a part is shaded, a range has its band and mid mark", () => {
  const html = render(BarChart, { bars: [{ label: "Mon", value: 10, part: 3 }, { label: "Tue", value: 6, low: 4, high: 9 }], ariaLabel: "Daily" });
  assert.match(html, /class="kit-bar nx-grow"/);
  assert.match(html, /class="kit-bar-part"/);
  assert.match(html, /class="kit-bar-range"/);
  assert.match(html, /class="kit-bar-mid"/);
});
test("a chart card has its title and big figure", () => {
  const html = render(ChartCard, { title: "Conversations", figure: "126", children: "chart" });
  assert.match(html, /<h3[^>]*>Conversations<\/h3>/);
  assert.match(html, /<span data-countup="">126<\/span>/);
});
```

- [ ] **Steps 2–5** as Task 2. Commit: `"Kit: chart card with area, line and bar charts and a hover label"`

---

### Task 4: CardWindow and SlidePanel

**Files:**
- Create: `apps/web/app/kit/card-window.tsx`, `apps/web/app/kit/slide-panel.tsx`, `apps/web/lib/kit/focus.ts`
- Modify: `apps/web/app/kit/kit.css`, `apps/web/app/kit/index.ts`
- Test: `apps/web/test/the-kit.test.mjs` (Task 4 section)

**Interfaces:**
- Consumes: Task 1 `originOf`.
- Produces: `CardWindow({ open, title, onClose, origin, children }: { open: boolean; title: string; onClose: () => void; origin?: HTMLElement | null; children: ReactNode })` and `SlidePanel({ open, title, onClose, children })` — closed renders nothing; open renders a backdrop and `<div role="dialog" aria-modal="true" aria-label={title}>` with a ✕ button named "Close"; Escape and a backdrop click call `onClose`; on open focus moves to the dialog, Tab cycles inside it (`lib/kit/focus.ts`: `focusables(root): HTMLElement[]`, `nextFocus(list, current, back): HTMLElement`), and on close focus returns to `origin` (CardWindow) or the element focused before (SlidePanel). CardWindow uses `document.startViewTransition` with `view-transition-name` on the card when available, else a scale-in from `originOf(origin)`; plays `pop`. SlidePanel plays `whoosh`; full screen under 760 px. Both lock page scroll while open.

- [ ] **Step 1: Write the failing tests**

```js
test("a window is a named dialog with a Close, and renders nothing when shut", () => {
  assert.equal(render(CardWindow, { open: false, title: "Call back", onClose() {}, children: "x" }), "");
  const html = render(CardWindow, { open: true, title: "Call back", onClose() {}, children: "body" });
  assert.match(html, /role="dialog" aria-modal="true" aria-label="Call back"/);
  assert.match(html, /aria-label="Close"/);
});
test("a panel is a named dialog too", () => {
  assert.match(render(SlidePanel, { open: true, title: "Sara Khan", onClose() {}, children: "p" }), /role="dialog" aria-modal="true" aria-label="Sara Khan"/);
});
test("Tab stays inside, and Escape and focus return are wired", () => {
  const a = { id: "a" }, b = { id: "b" }, c = { id: "c" };
  assert.equal(nextFocus([a, b, c], c, false), a);
  assert.equal(nextFocus([a, b, c], a, true), c);
  const W = read("app/kit/card-window.tsx");
  assert.match(W, /"Escape"/);
  assert.match(W, /origin\?\.focus\(\)/);
  assert.match(W, /play\("pop"\)/);
  assert.match(read("app/kit/slide-panel.tsx"), /play\("whoosh"\)/);
});
```

- [ ] **Steps 2–5.** Commit: `"Kit: card into a window and slide-in panel"`

---

### Task 5: BoardColumn, BoardCard and pointer drag

**Files:**
- Create: `apps/web/app/kit/board.tsx` (`BoardColumn`, `BoardCard`, `useBoardDrag`)
- Modify: `apps/web/app/kit/kit.css`, `apps/web/app/kit/index.ts`
- Test: `apps/web/test/the-kit.test.mjs` (Task 5 section)

**Interfaces:**
- Consumes: Task 1 `columnAt`, Task 2 `StatusCard`/tones.
- Produces: `BoardColumn({ id, tone, title, count, active, children })` (`data-column={id}`, `active` lights it); `BoardCard({ id, tone, title, lines, draggable, onOpen, label })`; `useBoardDrag({ canDrop: (cardId: string, from: string, to: string) => boolean; onDrop: (cardId: string, from: string, to: string) => Promise<void> })` → `{ dragging: string | null; over: string | null; cardHandlers(cardId: string, column: string): { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown } }`. A drag starts after 6 px of movement (so a tap still opens the card); the card follows the pointer in a fixed-position clone that tilts 3°; `columnAt` over the columns' rects picks the target; dropping on the same column or one `canDrop` refuses sends nothing; `onDrop` rejecting leaves the card where it was (the hook never moves cards itself; the page re-reads or keeps state). Escape during a drag cancels. `play("chime")` after `onDrop` resolves.

- [ ] **Step 1: Write the failing tests**

```js
test("a column has its tone, name and count, and a card its tone", () => {
  const html = render(BoardColumn, { id: "today", tone: "mustard", title: "Today", count: 3, children: "" });
  assert.match(html, /data-column="today"/);
  assert.match(html, /class="kit-col tone-head-mustard/);
  assert.match(html, />3</);
  assert.match(render(BoardCard, { id: "t1", tone: "terra", title: "Call back", lines: ["Zipicka"], draggable: true, onOpen() {}, label: "Open follow-up: Call back" }), /class="kit-card tone-terra/);
});
test("a drop that is refused, or onto its own column, sends nothing; a failed one leaves the card", () => {
  const B = read("app/kit/board.tsx");
  assert.match(B, /if \(to === from \|\| !canDrop\(/);
  assert.match(B, /\.catch\(/);
  assert.match(B, /play\("chime"\)/);
  assert.match(B, /"Escape"/);
  assert.match(B, /DRAG_START_PX = 6/);
});
```

- [ ] **Steps 2–5.** Commit: `"Kit: board column and card with pointer drag"`

---

### Task 6: The two server fields

**Files:**
- Modify: `packages/db/src/staff-work.ts` (`StaffWorkAttention`, the candidates query adds `o.name as org_name`, the attention object), `packages/db/src/metrics.ts` (`getOverviewMetrics`), `packages/shared/src/types.ts` (`OverviewMetrics`), `apps/web/lib/api.ts` (`StaffWorkAttention`)
- Create: `packages/db/src/days.ts` (`zeroFillDays`)
- Test: `apps/api/test/the-front-page-shows-real-waits-and-days.test.mjs` (new)

**Interfaces:**
- Produces: `StaffWorkAttention.oldestWaiting: Array<{ conversationId: string; contactName: string | null; employeeName: string; businessSlug: string; businessName: string; since: string }>` (the six longest waits of any length, oldest first) and `waitingTotal: number`; `OverviewMetrics.conversationsByDay: Array<{ day: string; conversations: number }>` — the last 14 complete days (to yesterday), summed across businesses from `agent_quality_daily.conversations`, every day present; `zeroFillDays(rows: Array<{ day: string; conversations: number }>, endDay: string, days: number): Array<{ day: string; conversations: number }>` (pure; `day` as `YYYY-MM-DD`).

- [ ] **Step 1: Write the failing tests**

```js
import { zeroFillDays } from "../../../packages/db/src/days.ts";
test("every one of the last days is there, missing days as zero", () => {
  const out = zeroFillDays([{ day: "2026-10-30", conversations: 4 }], "2026-11-01", 3);
  assert.deepEqual(out, [
    { day: "2026-10-30", conversations: 4 },
    { day: "2026-10-31", conversations: 0 },
    { day: "2026-11-01", conversations: 0 },
  ]);
});
test("the six longest waits of any length, oldest first, and the total", () => {
  const SW = read("packages", "db", "src", "staff-work.ts");
  assert.match(SW, /oldestWaiting: \[\.\.\.waiting\]\s*\.sort\([^)]*\)\s*\.slice\(0, 6\)/);
  assert.match(SW, /waitingTotal: waiting\.length/);
  assert.match(SW, /o\.name as org_name/);
});
test("the overview carries the days, summed across businesses, to yesterday", () => {
  const M = read("packages", "db", "src", "metrics.ts");
  assert.match(M, /from agent_quality_daily/);
  assert.match(M, /day < current_date/);
  assert.match(M, /zeroFillDays\(/);
  assert.match(read("packages", "shared", "src", "types.ts"), /conversationsByDay: Array<\{ day: string; conversations: number \}>/);
});
```

- [ ] **Steps 2–5.** Run the whole API suite. Commit: `"Front page data: the longest waits of any length, and conversations per day"`

---

### Task 7: The admin front page

**Files:**
- Modify: `apps/web/app/deck-console.tsx`, `apps/web/app/deck/deck.css` (remove the rules the kit replaces for `.stats`, `.stat`, the area chart)
- Create: `apps/web/app/front/waiting-cards.tsx`
- Test: `apps/web/test/the-front-page-in-cream.test.mjs` (new)

**Interfaces:**
- Consumes: Tasks 2–3 (`NumberTile`, `StatusCard`, `ChartCard`, `AreaChart`), Task 1 (`waitTone`, `formatWait`), Task 6 (`getStaffWork().attention.oldestWaiting`, `waitingTotal`, `overview.conversationsByDay`).
- Produces: `WaitingCards({ waiting, total, now }: { waiting: StaffWorkAttention["oldestWaiting"]; total: number; now: number })` — presentational and pure so it renders in tests; the page fetches and passes `Date.now()`.

- [ ] **Step 1: Write the failing tests**

```js
test("customers waiting are cards in their wait's colour, linking to the chat, longest first", () => {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const waiting = [
    { conversationId: "c1", contactName: "Sara Khan", employeeName: "Ralph Simeon", businessSlug: "sfs", businessName: "SFS International", since: "2026-11-01T09:00:00Z" },
    { conversationId: "c2", contactName: null, employeeName: "Keshav Arora", businessSlug: "zipicka", businessName: "Zipicka", since: "2026-11-02T11:50:00Z" },
  ];
  const html = render(WaitingCards, { waiting, total: 9, now });
  assert.ok(html.indexOf("Sara Khan") < html.indexOf("Zipicka"));
  assert.match(html, /tone-ink[^"]*"[^>]*href="\/inbox\?conversation=c1"/);
  assert.match(html, /tone-forest/);
  assert.match(html, /1 d 3 h/);
  assert.match(html, /\+7 more waiting/);
  assert.match(html, /href="\/deck\/activity"/);
  assert.match(render(WaitingCards, { waiting: [], total: 0, now }), /Nobody is waiting\./);
});
test("the front page uses the kit: six tiles, the waiting cards, a real conversations chart", () => {
  const P = read("app/deck-console.tsx");
  assert.match(P, /<NumberTile/);
  assert.match(P, /<WaitingCards/);
  assert.match(P, /<AreaChart[\s\S]{0,200}conversationsByDay/);
  assert.doesNotMatch(P, /className="stat glass/);
  // The four quick links are ink pills; the intent bars grow in.
  assert.match(P, /className="kit-pill"/);
  assert.match(P, /className="kit-bar nx-grow"|kit-bar nx-grow/);
});
```

- [ ] **Steps 2–5.** Commit: `"Front page in Cream: number tiles, customers waiting, a real conversations chart"`

---

### Task 8: The Workspace board on the kit

**Files:**
- Modify: `apps/web/app/deck/board/page.tsx`, `apps/web/app/deck/board/board.css`, `apps/web/app/deck/board/automations.tsx` (cards only)
- Create: `apps/web/app/deck/board/follow-up-window.tsx`
- Test: `apps/web/test/the-board-in-cream.test.mjs` (new)

**Interfaces:**
- Consumes: Tasks 4–5 (`CardWindow`, `BoardColumn`, `BoardCard`, `useBoardDrag`), `columns.ts` (unchanged rules: `columnFor`, `dueDateFor`).
- Produces: `FollowUpWindow({ task, onClose, onMove, onDone, origin }: { task: TaskRecord | null; onClose: () => void; onMove: (to: "overdue" | "today" | "later") => Promise<void>; onDone: () => Promise<void>; origin: HTMLElement | null })` — when `task` is null while open, shows "This follow-up is gone." and Close.
- Tone map exported from the page module: `COLUMN_TONE = { overdue: "terra", today: "mustard", later: "forest", done: "ink" } as const`.

- [ ] **Step 1: Write the failing tests**

```js
test("the columns take the video's colours", async () => {
  const { COLUMN_TONE } = await import("@/app/deck/board/page");
  assert.deepEqual(COLUMN_TONE, { overdue: "terra", today: "mustard", later: "forest", done: "ink" });
});
test("a follow-up's window offers Mark done, Open chat and Move to — and says when it is gone", () => {
  const task = { id: "t1", title: "Call back", notes: null, businessName: "Zipicka", employeeName: "Ralph", contactName: "Sara", conversationId: "c9", dueAt: null, status: "open", isOverdue: false };
  const html = render(FollowUpWindow, { task, onClose() {}, onMove: async () => {}, onDone: async () => {}, origin: null });
  for (const word of ["Mark done", "Open chat", "Move to"]) assert.match(html, new RegExp(word));
  assert.match(html, /href="\/inbox\?conversation=c9"/);
  assert.match(render(FollowUpWindow, { task: null, onClose() {}, onMove: async () => {}, onDone: async () => {}, origin: null }), /This follow-up is gone\./);
});
test("the board drags with the kit's pointer drag, never the browser's", () => {
  const P = read("app/deck/board/page.tsx");
  assert.match(P, /useBoardDrag\(/);
  assert.doesNotMatch(P, /draggable=\{task\.status === "open"\}/);
  assert.doesNotMatch(P, /onDragStart/);
  // On a phone the columns scroll sideways, one at a time.
  const CSS = read("app/deck/board/board.css");
  assert.match(CSS.slice(CSS.indexOf("@media (max-width")), /scroll-snap-type: x mandatory/);
});
```

- [ ] **Steps 2–5.** Run both full suites (board guard tests). Commit: `"Workspace board in Cream: coloured columns, drag by finger or mouse, a window per follow-up"`

---

### Task 9: Customers — cards and the profile panel

**Files:**
- Modify: `apps/web/app/deck/customers/page.tsx`, `apps/web/app/deck/customers/customers.css`
- Create: `apps/web/app/deck/customers/history-cards.tsx`
- Test: `apps/web/test/customers-in-cream.test.mjs` (new)

**Interfaces:**
- Consumes: Tasks 2 and 4 (`StatusCard`, `SlidePanel`).
- Produces: `HistoryCards({ conversations }: { conversations: Array<{ id: string; status: "open" | "pending" | "resolved" | "closed"; channel: string; lastMessageAt: string | null }> })`; `STATE_TONE = { open: "forest", pending: "mustard", resolved: "ink", closed: "ink" } as const`.

- [ ] **Step 1: Write the failing tests**

```js
test("a customer's conversations are cards in their state's colour", () => {
  const html = render(HistoryCards, { conversations: [{ id: "a", status: "open", channel: "whatsapp", lastMessageAt: null }, { id: "b", status: "closed", channel: "email", lastMessageAt: null }] });
  assert.match(html, /tone-forest/);
  assert.match(html, /tone-ink/);
  assert.match(html, /href="\/inbox\?conversation=a"/);
});
test("the profile slides in, and the admin-only export is untouched", () => {
  const P = read("app/deck/customers/page.tsx");
  assert.match(P, /<SlidePanel/);
  assert.match(P, /isOperator \? \(\s*<div className="cu-export">/);
});
```

- [ ] **Steps 2–5.** Commit: `"Customers in Cream: cards and a profile that slides in"`

---

### Task 10: Forecast and Agent quality on chart cards

**Files:**
- Modify: `apps/web/app/deck/forecast/page.tsx`, `apps/web/app/deck/forecast/forecast.css`, `apps/web/app/deck/quality/page.tsx`, `apps/web/app/deck/quality/quality.css`
- Test: `apps/web/test/forecast-and-quality-in-cream.test.mjs` (new)

**Interfaces:**
- Consumes: Tasks 2–3 (`NumberTile`, `ChartCard`, `BarChart`).

- [ ] **Step 1: Write the failing tests**

```js
test("forecasts draw as range bands, and the refusals stay", () => {
  const F = read("app/deck/forecast/page.tsx");
  assert.match(F, /<BarChart[\s\S]{0,300}low:/);
  assert.match(F, /<ChartCard/);
  assert.match(F, /fc-blocked/); // the refusal cards are still drawn
});
test("agent quality: number tiles and a daily chart with the escalated part shaded", () => {
  const Q = read("app/deck/quality/page.tsx");
  assert.match(Q, /<NumberTile/);
  assert.match(Q, /<BarChart[\s\S]{0,300}part:/);
});
```

The API suite's existing Forecast/Quality guard tests are part of this task's green bar.

- [ ] **Steps 2–5.** Commit: `"Forecast and Agent quality in Cream: chart cards with hover labels"`

---

### Task 11: Business HQ overview

**Files:**
- Modify: `apps/web/app/deck/hq/overview.tsx`, `apps/web/app/deck/hq/hq.css`
- Test: `apps/web/test/business-hq-overview.test.mjs` (add)

- [ ] **Step 1: Write the failing test**

```js
test("each business card is edged by its health, and its ring draws in", () => {
  const html = renderToStaticMarkup(createElement(HqOverview, { businesses: BUSINESSES }));
  assert.match(html, /hq-card edge-terra|hq-card edge-mustard/);
  assert.match(html, /hq-card edge-forest/);
  assert.match(html, /class="hq-ring-fill nx-draw"[^>]*pathLength="1"|pathLength="1"[^>]*class="hq-ring-fill nx-draw"/);
});
```

Edge from `scoreTone`: good → forest, warn → mustard, crit → terra.

- [ ] **Steps 2–5.** Commit: `"Business HQ in Cream: cards edged by health"`

---

### Task 12: See every page in the browser

**Files:** outside the repo: `C:\CLAUDE CODE\bacora\.claude\nexus-mock\` (a `pages-mock.mjs` with `/api/metrics/overview` incl. `conversationsByDay`, `/api/activity/staff-work` incl. `oldestWaiting`, `/api/tasks`, organizations, team, contacts and a contact's detail, forecast, quality and HQ answers shaped from `apps/web/lib/api.ts`), and an operator session minted like the staff one (dev secret, localhost only).

- [ ] **Step 1:** Run each page as the admin at desktop width; check with `read_page` and screenshots: tiles count up, waiting cards' colours and links, the chart's hover label (pointer and ←/→), the board's colours.
- [ ] **Step 2:** Drag a card by mouse and by touch (synthetic pointer events) to Today and to Done; a refused drop (stand-in answers 500) springs back with the error; Enter opens a card's window, Tab stays in, Escape returns focus; Move to works.
- [ ] **Step 3:** Customers: open a profile panel and close it by Escape. Forecast, Quality, HQ: hover labels, tiles.
- [ ] **Step 4:** Warm Night and 375 px for every page; no sideways scroll (`scrollWidth`), long and Arabic names stay on one line.
- [ ] **Step 5:** Fix what is found — each fix with a test first — then both full suites.

## Deploy (after the owner's review and "Deploy it")

Merge `cream-pages-2a` into `main`, `git push origin main`, `scripts/deploy.sh` on the VPS from the hPanel console, wait for "PASS - all three running images were built from <sha>". No database change.
