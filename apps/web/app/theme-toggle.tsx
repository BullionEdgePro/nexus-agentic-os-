"use client";

import { useEffect, useState } from "react";
import { THEME_KEY } from "@/lib/theme";

/**
 * Light or dark — the Clear Sky and the Night Sky.
 *
 * The choice is this browser's, kept in localStorage under THEME_KEY, and is
 * applied to <html data-theme> before first paint by THEME_BOOT (rendered in
 * app/layout.tsx), so a dark console never flashes white on load. With no
 * choice yet the console is light — the brand's look — and a person switches
 * once.
 *
 * The switch reveals the new sky as a circle spreading from where it was
 * pressed (the View Transitions API), falls back to a short cross-fade where
 * that API does not exist, and skips both under reduced motion.
 */
type Theme = "light" | "dark";

function current(): Theme {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "light";
}

export function ThemeToggle({ compact }: { compact?: boolean }) {
  const [theme, setTheme] = useState<Theme>("light");

  // Read what the boot script applied — the server cannot know it.
  useEffect(() => setTheme(current()), []);

  function apply(next: Theme) {
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private mode or blocked storage: the switch still works for this visit.
    }
    setTheme(next);
  }

  function toggle(event: React.MouseEvent<HTMLButtonElement>) {
    const next: Theme = theme === "dark" ? "light" : "dark";
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const root = document.documentElement;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };

    if (!reduce && typeof doc.startViewTransition === "function") {
      const rect = event.currentTarget.getBoundingClientRect();
      root.style.setProperty("--nx-x", `${rect.left + rect.width / 2}px`);
      root.style.setProperty("--nx-y", `${rect.top + rect.height / 2}px`);
      doc.startViewTransition(() => apply(next));
      return;
    }
    if (!reduce) {
      root.classList.add("nx-theme-fade");
      window.setTimeout(() => root.classList.remove("nx-theme-fade"), 400);
    }
    apply(next);
  }

  const dark = theme === "dark";
  return (
    <button
      type="button"
      className={`nx-theme${dark ? " is-dark" : ""}${compact ? " compact" : ""}`}
      onClick={toggle}
      role="switch"
      aria-checked={dark}
      aria-label={dark ? "Dark theme on — switch to light" : "Light theme on — switch to dark"}
      title={dark ? "Switch to light" : "Switch to dark"}
    >
      <span className="nx-theme-track" aria-hidden="true">
        <span className="nx-theme-stars">
          <i />
          <i />
          <i />
        </span>
        <span className="nx-theme-cloud" />
        <span className="nx-theme-knob">
          <span className="nx-theme-crater" />
          <span className="nx-theme-crater c2" />
        </span>
      </span>
      {compact ? null : <span className="nx-theme-label">{dark ? "Dark" : "Light"}</span>}
    </button>
  );
}
