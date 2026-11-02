/**
 * Where a card-into-a-window grows from (2 Nov 2026, Cream pages 2a): the
 * card's centre in percent of the viewport, for the window's transform-origin
 * when the browser has no View Transitions. Pure.
 */
const clamp = (v: number) => Math.min(100, Math.max(0, v));

export function originOf(
  rect: { left: number; top: number; width: number; height: number },
  viewport: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: clamp(Math.round(((rect.left + rect.width / 2) / viewport.width) * 100)),
    y: clamp(Math.round(((rect.top + rect.height / 2) / viewport.height) * 100)),
  };
}
