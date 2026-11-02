import { scaleLinear, smoothPath } from "@/lib/kit/chart-math";

/**
 * A number tile (2 Nov 2026, Cream pages 2a): an icon in a circle, a label, a
 * big figure that counts up (part 1's `data-countup`), and the note that says
 * what the number covers. A sparkline only when real points exist.
 */
export function NumberTile({
  label,
  value,
  unit,
  note,
  icon,
  spark,
}: {
  label: string;
  value: string;
  unit?: string;
  note?: string;
  /** An SVG path `d` drawn in a 24×24 box. */
  icon?: string;
  spark?: number[];
}) {
  return (
    <div className="kit-tile">
      {icon ? (
        <span className="kit-tile-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d={icon} />
          </svg>
        </span>
      ) : null}
      <span className="kit-tile-label">{label}</span>
      <span className="kit-tile-figure">
        <span data-countup="">{value}</span>
        {unit ? <small>{unit}</small> : null}
      </span>
      {note ? <span className="kit-tile-note">{note}</span> : null}
      {spark && spark.length >= 2 ? <Spark values={spark} /> : null}
    </div>
  );
}

function Spark({ values }: { values: number[] }) {
  const x = scaleLinear([0, values.length - 1], [0, 88]);
  const y = scaleLinear([Math.min(...values), Math.max(...values)], [28, 2]);
  const d = smoothPath(values.map((v, i) => [x(i), y(v)]));
  return (
    <svg className="kit-spark-svg" viewBox="0 0 88 30" aria-hidden="true">
      <path className="kit-spark nx-draw" d={d} pathLength="1" />
    </svg>
  );
}
