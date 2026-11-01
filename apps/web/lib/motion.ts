/**
 * The motion kit's helpers (spec 2026-11-01-cream-foundation-design.md §3).
 *
 * The CSS in app/motion.css does the moving; these are the few things CSS
 * cannot do on its own: counting a figure up, and remembering where a click
 * happened so a window can grow out of that spot.
 */

export interface CountParts {
  prefix: string;
  value: number;
  decimals: number;
  suffix: string;
  grouped: boolean;
}

const NUMBER = /^(\D*?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\D*)$/;

/** Splits "$1,014,640" into its parts; null for anything that is not one number. */
export function parseCount(text: string): CountParts | null {
  const m = NUMBER.exec(text.trim());
  if (!m) return null;
  const [, prefix, whole, fraction = "", suffix] = m;
  return {
    prefix,
    value: Number(`${whole.replace(/,/g, "")}${fraction ? `.${fraction}` : ""}`),
    decimals: fraction.length,
    suffix,
    grouped: whole.includes(","),
  };
}

/** Writes `value` the way the original figure was written. */
export function formatCount(parts: CountParts, value: number): string {
  const fixed = value.toFixed(parts.decimals);
  const [whole, fraction] = fixed.split(".");
  const body = parts.grouped ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : whole;
  return `${parts.prefix}${body}${fraction ? `.${fraction}` : ""}${parts.suffix}`;
}

/**
 * Counts `el`'s figure up from zero over `ms`, ending on its exact text.
 *
 * It writes the existing text node rather than replacing it, because React
 * owns that node: replacing it would leave React updating a detached one, and
 * the figure would freeze. If React writes a new value mid-count, the count
 * stops and React's value stands.
 */
export function countUp(el: HTMLElement, ms = 700): void {
  const node = el.firstChild;
  if (!node || node.nodeType !== Node.TEXT_NODE) return;
  const target = node.nodeValue ?? "";
  const parts = parseCount(target);
  if (!parts || parts.value === 0) return;
  el.dataset.counted = "1";
  const start = performance.now();
  let written = formatCount(parts, 0);
  node.nodeValue = written;
  const frame = (now: number) => {
    if (node.nodeValue !== written) return; // React changed it: let that stand.
    const t = Math.min(1, (now - start) / ms);
    const eased = 1 - (1 - t) ** 3;
    written = t >= 1 ? target : formatCount(parts, parts.value * eased);
    node.nodeValue = written;
    if (t < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Where the last press happened, for windows that grow out of it. */
export function setPopOrigin(x: number, y: number): void {
  const root = document.documentElement.style;
  root.setProperty("--nx-ox", `${Math.round(x)}px`);
  root.setProperty("--nx-oy", `${Math.round(y)}px`);
}
