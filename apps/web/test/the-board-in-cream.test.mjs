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
