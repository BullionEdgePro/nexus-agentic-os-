"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { NAV } from "@/lib/nav";
import "./command-palette.css";

/**
 * Jump anywhere with ⌘K / Ctrl-K.
 *
 * The rail is grouped now, but reaching a screen still means finding its row and
 * clicking. On thirteen-to-nineteen destinations a keyboard jump is faster than
 * any menu — type two letters of the name and press enter. It draws from the
 * same one nav list as the rail and hides the same doors the role cannot open,
 * so it can never offer a screen the API would refuse.
 *
 * Deliberately keyboard-first and dependency-free: no backend, no search index,
 * just the screens a person already has. Mounted once in the shell, so every
 * signed-in page has it.
 */
export function CommandPalette({ role }: { role: "operator" | "employee" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const items = useMemo(() => {
    const visible =
      role === "operator" ? NAV.filter((i) => !i.staffOnly) : NAV.filter((i) => !i.operatorOnly);
    const query = q.trim().toLowerCase();
    return query ? visible.filter((i) => i.label.toLowerCase().includes(query)) : visible;
  }, [role, q]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setActive(0);
    // A frame later, so the element exists to receive focus.
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Keep the highlight in range as the filter shrinks the list.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, items.length - 1)));
  }, [items.length]);

  if (!open) return null;

  const go = (href: string) => {
    setOpen(false);
    // A full navigation rather than the router: it works identically from the
    // operator console (which is not the shell's router tree) and from any deck
    // page, and this is navigation, not a data mutation to keep client state for.
    window.location.href = href;
  };

  return (
    <div
      className="cmdp-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div className="cmdp" role="dialog" aria-label="Jump to a screen">
        <input
          ref={inputRef}
          className="cmdp-input"
          placeholder="Jump to a screen…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const item = items[active];
              if (item) go(item.href);
            }
          }}
        />
        <ul className="cmdp-list">
          {items.length === 0 ? (
            <li className="cmdp-empty">No screen matches “{q}”.</li>
          ) : (
            items.map((item, i) => (
              <li key={item.href}>
                <button
                  type="button"
                  className={`cmdp-item${i === active ? " on" : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(item.href)}
                >
                  <span className="cmdp-ic">{item.icon}</span>
                  <span>{item.label}</span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="cmdp-foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          to move · <kbd>↵</kbd> to open · <kbd>esc</kbd> to close
        </div>
      </div>
    </div>
  );
}
