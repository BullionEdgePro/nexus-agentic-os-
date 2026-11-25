/**
 * Board dragging's decisions, with no DOM (2 Nov 2026, Cream pages 2a): which
 * column the pointer is over, and the order of a column after a drop. Pure.
 */
export type Box = { key: string; left: number; right: number; top: number; bottom: number };

export function columnAt(x: number, y: number, boxes: Box[]): string | null {
  const hit = boxes.find((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
  return hit ? hit.key : null;
}

export function orderAfterDrop<T extends { id: string }>(cards: T[], id: string, toIndex: number): T[] {
  const moving = cards.find((c) => c.id === id);
  if (!moving) return cards;
  const rest = cards.filter((c) => c.id !== id);
  const at = Math.max(0, Math.min(toIndex, rest.length));
  return [...rest.slice(0, at), moving, ...rest.slice(at)];
}

/**
 * Where a drop goes: the column under the pointer, unless that is no column,
 * the card's own column, or one the board refuses — then nowhere, and nothing
 * is sent.
 */
export function dropTarget(from: string, to: string | null, allowed: boolean): string | null {
  if (!to || to === from || !allowed) return null;
  return to;
}

/**
 * The columns as far as they can be seen: each clipped to the board's visible
 * area, and the ones scrolled out of it dropped. A column off the edge must not
 * take a drop nobody could see land.
 */
export function visibleBoxes(boxes: Box[], clip: Omit<Box, "key"> | null): Box[] {
  if (!clip) return boxes;
  return boxes
    .map((b) => ({
      key: b.key,
      left: Math.max(b.left, clip.left),
      right: Math.min(b.right, clip.right),
      top: Math.max(b.top, clip.top),
      bottom: Math.min(b.bottom, clip.bottom),
    }))
    .filter((b) => b.right > b.left && b.bottom > b.top);
}

/**
 * How far to scroll a board this frame while a card is dragged near its edge:
 * nothing in the middle, up to `max` pixels at (or past) the edge, negative
 * towards the left.
 */
export function edgeScroll(x: number, left: number, right: number, zone = 48, max = 18): number {
  if (x > right - zone) return Math.round(Math.min(1, (x - (right - zone)) / zone) * max);
  if (x < left + zone) return -Math.round(Math.min(1, (left + zone - x) / zone) * max);
  return 0;
}

/**
 * How far to scroll the page this frame while a card is held at height `y` of a
 * screen `height` tall (compact board review, 25 Nov 2026): the steps stack on a
 * phone and a finger cannot scroll the page in the middle of a drag, so a card
 * held near the top or bottom scrolls it. Only once the card has gone 12px or
 * more that way from where the drag began (`from`), so a card picked up near an
 * edge, or a finger trembling there, does not set the page off. A finger's edge
 * is a fifth of the screen, at most 160px (it covers what it points at); a
 * mouse's is the board's 48px.
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §3.4
 */
export function pageScroll(y: number, from: number, height: number, touch: boolean): number {
  const step = edgeScroll(y, 0, height, touch ? Math.min(160, Math.round(height / 5)) : 48);
  return (step > 0 && y > from + 12) || (step < 0 && y < from - 12) ? step : 0;
}

/**
 * The column a drop may go to: the one under the pointer by the board's boxes,
 * and only if that is also what the screen shows there (`onScreen`, the column
 * the pointer is over on the page) — never one hidden under the phone's tab bar
 * or the dock, nor one past the window's edge (review, 25 Nov 2026).
 */
export function seenColumn(byBox: string | null, onScreen: string | null): string | null {
  return byBox !== null && byBox === onScreen ? byBox : null;
}
