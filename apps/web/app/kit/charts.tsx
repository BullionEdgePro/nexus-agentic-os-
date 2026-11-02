"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { areaPath, bandIndex, nearestIndex, niceMax, scaleLinear, smoothPath } from "@/lib/kit/chart-math";

/**
 * The kit's charts (2 Nov 2026, Cream pages 2a): an area or line chart that
 * draws in, and bars that grow — stacked in two tones, or a range band with a
 * mid mark. A dark hover label follows the pointer or finger to the nearest
 * point; the chart takes focus and ←/→ step through the points, read out by a
 * polite live region. Fewer than two points draw nothing and say why.
 */

export type Point = { label: string; value: number };
export type Bar = {
  label: string;
  value: number;
  part?: number;
  low?: number;
  high?: number;
  /** Said after the figures in the hover label ("the same weekday last week said 6"). */
  note?: string;
  /** A day still in progress: drawn marked, so it never reads as a collapse. */
  partial?: boolean;
};

const EMPTY = "Not enough days yet to draw a line.";
const W = 600;
const H = 200;
const PAD = { l: 6, r: 6, t: 16, b: 10 };

type Format = (n: number) => string;
const plain: Format = (n) => n.toLocaleString();

function stepper(count: number, active: number | null, set: (i: number | null) => void) {
  return (event: KeyboardEvent) => {
    if (count === 0) return;
    const at = active ?? -1;
    if (event.key === "ArrowRight") set(Math.min(count - 1, at + 1));
    else if (event.key === "ArrowLeft") set(Math.max(0, at < 0 ? count - 1 : at - 1));
    else if (event.key === "Home") set(0);
    else if (event.key === "End") set(count - 1);
    else if (event.key === "Escape") set(null);
    else return;
    event.preventDefault();
  };
}

function SeriesChart({ kind, points, ariaLabel, format = plain }: { kind: "area" | "line"; points: Point[]; ariaLabel: string; format?: Format }) {
  const [active, setActive] = useState<number | null>(null);
  const live = useId();
  if (points.length < 2) return <p className="kit-chart-empty">{EMPTY}</p>;

  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const x = scaleLinear([0, points.length - 1], [PAD.l, W - PAD.r]);
  const y = scaleLinear([0, max], [H - PAD.b, PAD.t]);
  const xy = points.map((p, i): [number, number] => [x(i), y(p.value)]);
  const xs = xy.map((p) => p[0]);
  const at = active !== null ? xy[active] : null;

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    setActive(nearestIndex(xs, ((event.clientX - box.left) / box.width) * W));
  };

  return (
    <div
      className="kit-chart"
      tabIndex={0}
      aria-label={`${ariaLabel}. Use the arrow keys to read each point.`}
      aria-describedby={live}
      onPointerMove={onMove}
      onPointerDown={onMove}
      // A lifted finger also "leaves"; on a touch screen the label stays until
      // the chart loses focus (a tap elsewhere).
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setActive(null);
      }}
      onBlur={() => setActive(null)}
      onKeyDown={stepper(points.length, active, setActive)}
    >
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel} preserveAspectRatio="none">
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} className="kit-grid" x1={0} x2={W} y1={y(max * f)} y2={y(max * f)} />
        ))}
        {kind === "area" ? <path className="kit-area" d={areaPath(xy, H - PAD.b)} /> : null}
        {/* Drawn in by a sweeping clip (kit.css), not a dash: a dash cannot span
            a line whose box stretches wider than the viewBox. */}
        <path className="kit-line kit-reveal" d={smoothPath(xy)} vectorEffect="non-scaling-stroke" />
        {at ? <line className="kit-guide" x1={at[0]} x2={at[0]} y1={PAD.t} y2={H - PAD.b} vectorEffect="non-scaling-stroke" /> : null}
      </svg>
      {at && active !== null ? (
        <>
          <span className="kit-dot" style={{ left: `${(at[0] / W) * 100}%`, top: `${(at[1] / H) * 100}%` }} aria-hidden="true" />
          <span className="kit-tip" style={{ left: `${(at[0] / W) * 100}%`, top: `${(at[1] / H) * 100}%` }} aria-hidden="true">
            <b>{format(points[active]!.value)}</b>
            <span>{points[active]!.label}</span>
          </span>
        </>
      ) : null}
      <div className="kit-axis" aria-hidden="true">
        <span>{points[0]!.label}</span>
        <span>{points[points.length - 1]!.label}</span>
      </div>
      <span id={live} className="kit-sr" aria-live="polite">
        {active !== null ? `${points[active]!.label}: ${format(points[active]!.value)}` : ""}
      </span>
    </div>
  );
}

export function AreaChart(props: { points: Point[]; ariaLabel: string; format?: Format }) {
  return <SeriesChart kind="area" {...props} />;
}

export function LineChart(props: { points: Point[]; ariaLabel: string; format?: Format }) {
  return <SeriesChart kind="line" {...props} />;
}

const pct = (n: number) => `${Math.max(0, Math.min(100, n))}%`;

const isRange = (bar: Bar): bar is Bar & { low: number; high: number } => bar.low != null && bar.high != null;

/** What a bar says when hovered, tapped or stepped to: its figures, then its note. */
export function describeBar(bar: Bar, format: Format, partLabel?: string): string {
  const part = bar.part ? `, ${format(bar.part)} ${partLabel ?? "of them"}` : "";
  const figures = isRange(bar)
    ? `${format(bar.low)}–${format(bar.high)}, most likely ${format(bar.value)}`
    : `${format(bar.value)}${part}`;
  const notes = [bar.note, bar.partial ? "Still in progress, counts only so far" : undefined].filter(Boolean);
  return `${bar.label}: ${figures}${notes.length ? `. ${notes.join(". ")}` : ""}`;
}

export function BarChart({
  bars,
  ariaLabel,
  format = plain,
  partLabel,
}: {
  bars: Bar[];
  ariaLabel: string;
  format?: Format;
  /** What the shaded part of a bar is ("escalated"). */
  partLabel?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const live = useId();
  if (bars.length === 0) return <p className="kit-chart-empty">{EMPTY}</p>;
  const max = niceMax(Math.max(...bars.map((b) => Math.max(b.value, b.high ?? 0))));
  const share = (v: number) => (v / max) * 100;

  // The bar under the pointer, from where it is across the chart — so a finger
  // sliding along (captured by wherever it went down) still moves the label.
  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const i = bandIndex(event.clientX - box.left, box.width, bars.length);
    if (i >= 0) setActive(i);
  };

  return (
    <div
      className="kit-chart kit-bars"
      tabIndex={0}
      aria-label={`${ariaLabel}. Use the arrow keys to read each bar.`}
      aria-describedby={live}
      onPointerMove={onMove}
      onPointerDown={onMove}
      // A lifted finger also "leaves"; on a touch screen the label stays until
      // the chart loses focus (a tap elsewhere).
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") setActive(null);
      }}
      onBlur={() => setActive(null)}
      onKeyDown={stepper(bars.length, active, setActive)}
    >
      <div className="kit-bars-row" role="img" aria-label={ariaLabel}>
        {bars.map((bar, i) => (
          <div
            key={`${bar.label}-${i}`}
            className={`kit-bar-col${bar.partial ? " partial" : ""}${active === i ? " on" : ""}`}
          >
            {isRange(bar) ? (
              <div className="kit-bar-range" style={{ bottom: pct(share(bar.low)), height: pct(share(bar.high - bar.low)) }}>
                <div
                  className="kit-bar-mid"
                  style={{ bottom: pct(bar.high > bar.low ? ((bar.value - bar.low) / (bar.high - bar.low)) * 100 : 50) }}
                />
              </div>
            ) : (
              <div className="kit-bar nx-grow" style={{ height: pct(share(bar.value)) }}>
                {bar.part ? <div className="kit-bar-part" style={{ height: pct(bar.value > 0 ? (bar.part / bar.value) * 100 : 0) }} /> : null}
              </div>
            )}
            {active === i ? (
              <span className="kit-tip kit-tip-bar" aria-hidden="true">
                <b>{isRange(bar) ? `${format(bar.low)}–${format(bar.high)}` : format(bar.value)}</b>
                <span>
                  {bar.label}
                  {isRange(bar) ? ` · most likely ${format(bar.value)}` : ""}
                  {bar.part ? ` · ${format(bar.part)} ${partLabel ?? "of them"}` : ""}
                </span>
                {bar.note ? <span>{bar.note}</span> : null}
                {bar.partial ? <span>still in progress</span> : null}
              </span>
            ) : null}
          </div>
        ))}
      </div>
      <div className="kit-axis" aria-hidden="true">
        <span>{bars[0]!.label}</span>
        <span>{bars[bars.length - 1]!.label}</span>
      </div>
      <span id={live} className="kit-sr" aria-live="polite">
        {active !== null ? describeBar(bars[active]!, format, partLabel) : ""}
      </span>
    </div>
  );
}
