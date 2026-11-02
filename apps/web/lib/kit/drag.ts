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
