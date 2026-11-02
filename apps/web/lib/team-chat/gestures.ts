/**
 * The two touch gestures on a bubble (2 Nov 2026): hold to open the reactions
 * and menu, swipe right to reply. Their thresholds live here so the bubble and
 * its tests agree. Pure.
 */
export const GESTURES = { holdMs: 450, swipePx: 64 } as const;

/** A swipe right far enough, and flat enough, to mean "reply" rather than scroll. */
export function swipeReply(dx: number, dy: number): boolean {
  return dx >= GESTURES.swipePx && Math.abs(dy) < 32;
}

/** A hold long enough, and still enough, to mean "react" rather than scroll. */
export function isLongPress(ms: number, movedPx: number): boolean {
  return ms >= GESTURES.holdMs && movedPx < 10;
}
