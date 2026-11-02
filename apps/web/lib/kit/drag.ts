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
