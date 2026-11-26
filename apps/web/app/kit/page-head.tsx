"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * One page header for every screen (26 Nov 2026, staff-first compact): the
 * title on one line, an ⓘ beside it, and the page's own actions on the same
 * row. The explanation that used to sit under every title — read once, then
 * scrolled past every day — waits behind the ⓘ. It stays on the page, hidden
 * until asked, so nothing written is lost and a screen reader still finds it
 * once opened. The Workflow page's header (25 Nov) is the look.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-compact-design.md §4.1
 */
export function PageHead({ title, about, children }: { title: string; about?: ReactNode; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      {/* Its own class: `.page-head` is deck.css's overview header (space-between). */}
      <header className="act-head act-titlebar">
        <h1>{title}</h1>
        {about ? (
          <button
            type="button"
            className="page-about"
            aria-label="About this page"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((v) => !v)}
          >
            ⓘ
          </button>
        ) : null}
        {children ? <div className="page-actions">{children}</div> : null}
      </header>
      {about ? (
        <p id={id} className="act-lede" hidden={!open}>
          {about}
        </p>
      ) : null}
    </>
  );
}
