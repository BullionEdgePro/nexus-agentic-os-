/**
 * Whether a message's reactions bar and menu open below or above it (2 Nov
 * 2026, final review). Below, as WhatsApp does — unless there is no room left
 * in the visible list, which is always the case for the newest message, the one
 * people react to most. Then above, if there is room there. Pure.
 */
type Edges = { top: number; bottom: number };

const GAP = 6;

export function menuPlacement(bubble: Edges, menuHeight: number, list: Edges): "below" | "above" {
  if (bubble.bottom + GAP + menuHeight <= list.bottom) return "below";
  if (bubble.top - GAP - menuHeight >= list.top) return "above";
  return "below";
}
