"use client";

/**
 * How a page looks while it loads, and when its load fails (26 Nov 2026,
 * staff-first compact piece 4) — the same on every page.
 *
 * Loading: an outline of soft bars rather than a bare "Loading…" line; a screen
 * reader still hears "Loading…". Failed: the page's own reason and a Try again
 * that calls the page's own load again — before this, the only way back from a
 * failed load was reloading the whole browser page.
 *
 * Styled by ./load-states.css, which each page that uses these imports (the
 * pieces import no CSS, so the render tests can draw them).
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-loading-design.md
 */
export function PageLoading({ rows = 3 }: { rows?: number }) {
  return (
    <div className="kit-loading" role="status" aria-live="polite">
      <span className="kit-sr">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <span key={i} className="kit-skel" aria-hidden="true" />
      ))}
    </div>
  );
}

export function LoadFailed({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div className="kit-failed" role="alert">
      <p className="kit-failed-reason">{reason}</p>
      <button type="button" className="kit-failed-retry" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
