/**
 * The maths under the kit's charts (2 Nov 2026, Cream pages 2a). No library:
 * a scale, round axis tops, a smooth line through the points, its filled area,
 * and the point nearest the pointer. Pure, and safe on the inputs real data
 * gives — no points, one point, a flat series — so a new business's empty week
 * never draws `NaN` into a path.
 */

export function scaleLinear(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d0 === d1) return () => r0;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

/** The axis top: 1, 2, 2.5 or 5 × 10ⁿ at or above the largest value. */
export function niceMax(max: number): number {
  if (!(max > 0)) return 1;
  const exp = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= max) return m * exp;
  return 10 * exp;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/** A smooth line through the points (Catmull-Rom drawn as cubic Béziers). */
export function smoothPath(points: Array<[number, number]>): string {
  if (points.length === 0) return "";
  const [first] = points;
  let d = `M${fmt(first![0])} ${fmt(first![1])}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${fmt(c1x)} ${fmt(c1y)} ${fmt(c2x)} ${fmt(c2y)} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return d;
}

/** The line closed down to the baseline: the area under it. */
export function areaPath(points: Array<[number, number]>, baseline: number): string {
  if (points.length === 0) return "";
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${smoothPath(points)} L${fmt(last[0])} ${fmt(baseline)} L${fmt(first[0])} ${fmt(baseline)} Z`;
}

/**
 * Which of `count` equal bands a point `x` across a `width` falls in, clamped
 * to the first and last; -1 when there is no width or no band. How a bar chart
 * picks the bar under a pointer or a sliding finger.
 */
export function bandIndex(x: number, width: number, count: number): number {
  if (width <= 0 || count <= 0) return -1;
  return Math.max(0, Math.min(count - 1, Math.floor((x / width) * count)));
}

/** The index of the x nearest the pointer; -1 when there are none. */
export function nearestIndex(xs: number[], x: number): number {
  let best = -1;
  let gap = Infinity;
  xs.forEach((value, i) => {
    const d = Math.abs(value - x);
    if (d < gap) {
      gap = d;
      best = i;
    }
  });
  return best;
}
