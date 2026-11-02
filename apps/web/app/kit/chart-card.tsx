import type { ReactNode } from "react";

/**
 * A chart card (2 Nov 2026, Cream pages 2a): the title, a big figure that
 * counts up, an optional note, optional period pills, and the chart.
 */
export function ChartCard({
  title,
  figure,
  note,
  periods,
  period,
  onPeriod,
  children,
}: {
  title: string;
  figure?: string;
  note?: string;
  periods?: Array<{ key: string; label: string }>;
  period?: string;
  onPeriod?: (key: string) => void;
  children: ReactNode;
}) {
  return (
    <section className="kit-chart-card">
      <header className="kit-chart-head">
        <div>
          <h3>{title}</h3>
          {figure ? (
            <span className="kit-chart-figure">
              <span data-countup="">{figure}</span>
            </span>
          ) : null}
          {note ? <p className="kit-chart-note">{note}</p> : null}
        </div>
        {periods && periods.length ? (
          <div className="kit-pills" role="group" aria-label="Period">
            {periods.map((p) => (
              <button
                key={p.key}
                type="button"
                className="kit-pill quiet"
                aria-pressed={p.key === period}
                onClick={() => onPeriod?.(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        ) : null}
      </header>
      {children}
    </section>
  );
}
