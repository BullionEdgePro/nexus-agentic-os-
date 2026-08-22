"use client";

import { useEffect } from "react";

/**
 * The last resort: the root layout itself failed.
 *
 * WHY IT CANNOT USE ANY OF THE OTHER FILES. This boundary REPLACES the root
 * layout, so it has to render its own <html> and <body> — and it cannot rely on
 * the stylesheets, the fonts or the theme tokens, because whatever broke may be
 * exactly the thing that was supposed to provide them. Every colour here is
 * therefore written out by hand.
 *
 * That is the one place in this codebase where a literal is correct rather than
 * a survivor of a palette change: a boundary that depends on the thing it is
 * catching is not a boundary.
 *
 * The CSS-literal gate reads .css files, so it never sees these and needs no
 * exemption — but that also means nothing here follows the palette when it
 * moves. `its hardcoded palette is checked against the real one` closes that:
 * it reads the token block and fails if any of these six values stops matching,
 * so the duplication is deliberate AND cannot silently rot.
 *
 * Kept short on purpose. If the root layout is failing, the useful advice is
 * "reload, and if it persists this is not something you can fix" — anything
 * longer is a guess about a state this file cannot inspect.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("The console failed to start", error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: "48px 24px",
          background: "#f8f9fb",
          color: "#0b3558",
          font: "16px/1.6 system-ui, -apple-system, 'Segoe UI', sans-serif",
        }}
      >
        <main
          style={{
            maxWidth: "58ch",
            background: "#ffffff",
            border: "1px solid #d4e0ed",
            borderRadius: 16,
            padding: 32,
          }}
        >
          <h1 style={{ margin: "0 0 14px", fontSize: 26, lineHeight: 1.25 }}>
            The console could not start.
          </h1>
          <p style={{ margin: "0 0 12px", color: "#476788" }}>
            This is not a problem with your data or with the agent — customers are still being
            answered. It is the console itself failing to load.
          </p>
          <p style={{ margin: "0 0 22px", color: "#476788" }}>
            Reloading sometimes clears it. If it does not, this needs somebody with access to the
            platform.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              font: "600 14px/1 system-ui, sans-serif",
              padding: "11px 16px",
              borderRadius: 8,
              border: "1px solid #0b3558",
              background: "#0b3558",
              color: "#ffffff",
              cursor: "pointer",
            }}
          >
            Reload the console
          </button>
          {error.digest ? (
            <p style={{ marginTop: 22, fontSize: 12.5, color: "#476788" }}>
              Quote{" "}
              <code style={{ background: "#f0f3f8", borderRadius: 4, padding: "2px 6px" }}>
                {error.digest}
              </code>{" "}
              when reporting this.
            </p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
