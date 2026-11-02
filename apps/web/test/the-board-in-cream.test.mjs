/**
 * The Workspace board in Cream (2 Nov 2026, part 2a): the video's pipeline —
 * coloured columns and cards, dragged by finger or mouse, and a window per
 * follow-up with Mark done, Open chat and Move to.
 * Spec: docs/superpowers/specs/2026-11-02-cream-pages-2a-design.md §3
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

import { COLUMN_TONE } from "@/app/deck/board/columns";
import { FollowUpWindow } from "@/app/deck/board/follow-up-window";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));

const task = {
  id: "t1",
  title: "Call back about the villa",
  notes: "Prefers mornings",
  businessName: "Zipicka",
  employeeName: "Ralph",
  contactName: "Sara",
  conversationId: "c9",
  dueAt: null,
  status: "open",
  isOverdue: false,
  completedByName: null,
};
const noop = async () => {};

test("the columns take the video's colours", () => {
  assert.deepEqual(COLUMN_TONE, { overdue: "terra", today: "mustard", later: "forest", done: "ink" });
});

test("a follow-up's window offers Mark done, Open chat and Move to", () => {
  const html = render(FollowUpWindow, { task, onClose() {}, onMove: noop, onDone: noop, origin: null });
  for (const word of ["Mark done", "Open chat", "Move to"]) assert.match(html, new RegExp(word));
  assert.match(html, /href="\/inbox\?conversation=c9"/);
  assert.match(html, /Prefers mornings/);
  // Move to offers the other columns, never the one it is in, never Done.
  assert.match(html, />Overdue</);
  assert.match(html, />Today</);
  assert.doesNotMatch(html, /aria-label="Move to Later"/);
});

test("a window whose follow-up has gone says so instead of acting on it", () => {
  const html = render(FollowUpWindow, { task: null, onClose() {}, onMove: noop, onDone: noop, origin: null });
  assert.match(html, /This follow-up is gone\./);
  assert.doesNotMatch(html, /Mark done/);
});

test("a finished follow-up's window does not offer to move it", () => {
  const html = render(FollowUpWindow, { task: { ...task, status: "done", completedByName: "Shah" }, onClose() {}, onMove: noop, onDone: noop, origin: null });
  assert.doesNotMatch(html, /Move to/);
  assert.match(html, /Done by Shah/);
});

test("the board drags with the kit's pointer drag, never the browser's", () => {
  const P = read("app/deck/board/page.tsx");
  assert.match(P, /useBoardDrag\(/);
  assert.doesNotMatch(P, /draggable=\{task\.status === "open"\}/);
  assert.doesNotMatch(P, /onDragStart/);
  // Nothing drags out of Done: only open cards get the drag handlers.
  assert.match(P, /handlers=\{task\.status === "open" \?/);
  // A drop that fails reports it, so no chime plays for it.
  assert.match(P, /const failed = await moveTo\(taskId, column\);\s*if \(failed\) throw new Error\(failed\);/);
  // On a phone the columns scroll sideways, one at a time.
  const CSS = read("app/deck/board/board.css");
  assert.match(CSS.slice(CSS.indexOf("@media (max-width")), /scroll-snap-type: x mandatory/);
});

test("the board scrolls sideways whenever its columns do not fit, whatever the window", () => {
  // Found in the browser (Task 12): at 1024px the sidebar leaves ~760px, and a
  // breakpoint on the window's width let four 220px columns overflow with Done
  // cut off. The sideways scroll belongs to the board itself, at every width.
  const CSS = read("app/deck/board/board.css");
  const base = CSS.slice(0, CSS.indexOf("@media (max-width"));
  assert.match(base, /\.bd-board \{[^}]*grid-auto-flow: column;[^}]*overflow-x: auto;/);
  // A follow-up's title is a sentence: two lines, then an ellipsis.
  assert.match(base, /\.bd-board \.kit-card-title \{[^}]*-webkit-line-clamp: 2;/);
});

test("closing a follow-up's window puts the keyboard back on its card, even after it moved", () => {
  // Found in the browser (Task 12): after Move to, the card is a new element in
  // another column, so focusing the one the window opened from did nothing and
  // the keyboard fell to the top of the page.
  const B = read("app/kit/board.tsx");
  assert.match(B, /data-card=\{id\}/);
  const P = read("app/deck/board/page.tsx");
  assert.match(P, /if \(!card\.isConnected\) document\.querySelector<HTMLElement>\(`\[data-card="\$\{CSS\.escape\(id\)\}"\]`\)\?\.focus\(\);/);
});

test("after Mark done the keyboard stays in the window, though the button it was on is gone", () => {
  // Found in the browser (Task 12): Mark done removes itself (the follow-up is
  // done), and focus fell out of the window onto the page behind it.
  const W = read("app/deck/board/follow-up-window.tsx");
  assert.match(W, /if \(box && !box\.contains\(document\.activeElement\)\) box\.focus\(\);/);
});

test("a refused change reloads the board, so a follow-up a colleague finished shows as it is", () => {
  // Final review: completed elsewhere, a follow-up's drop or Mark done was
  // refused, the stale card sprang back, and its window kept offering Mark done
  // — the board only reloaded after a change that saved. A reload is a read,
  // never a second attempt.
  const P = read("app/deck/board/page.tsx");
  assert.match(P, /setActionError\(reason\);\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*void load\(business\);\s*return reason;/);
});
