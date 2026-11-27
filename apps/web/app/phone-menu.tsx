"use client";

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { signOutHere } from "@/lib/sign-out";
import { activeHref, railSections, toneOf } from "@/lib/nav";
import "./phone-menu.css";

/**
 * A staff phone's Menu (audit, 4 Nov 2026).
 *
 * Under 760px the dock is hidden for the four bottom tabs, and the dock was the
 * only way to Sign out, Search, or reach My settings, Connections, Board,
 * Knowledge and Workflow — on a shared phone the next person stayed signed in as
 * the last. This opens the same doors the dock offers that person (visibleNav,
 * console-shell.tsx), with Search and Sign out. Shown at phone width only, by
 * the toolbar it sits in.
 *
 * It reads like the rail (27 Nov 2026, staff-first piece 6): the same sections
 * in the same order (railSections, all of them — the phone has no More), each
 * door with its tile, two to a row. It was a flat list of 17 text links in a
 * different order, and the tab bar covered its bottom.
 */
export function PhoneMenu({ items }: { items: Array<{ href: string; label: string; icon?: ReactNode }> }) {
  const [open, setOpen] = useState(false);
  const current = activeHref(usePathname() ?? "/");
  const { main, more } = railSections(items);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button type="button" className="pmenu-open" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
        <span>Menu</span>
      </button>
      {open ? (
        <div className="pmenu-backdrop" onClick={() => setOpen(false)}>
          <div className="pmenu-sheet" role="dialog" aria-modal="true" aria-label="Menu" onClick={(event) => event.stopPropagation()}>
            <div className="pmenu-head">
              <strong>Menu</strong>
              <button type="button" className="pmenu-close" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
            <button
              type="button"
              className="pmenu-search"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event("nexus:open-search"));
              }}
            >
              Search
            </button>
            <nav className="pmenu-nav" aria-label="All pages">
              {[...main, ...more].map((section) => (
                <Fragment key={section.title || "unfiled"}>
                  {section.title ? <h3 className="pmenu-group">{section.title}</h3> : null}
                  <div className="pmenu-links">
                    {section.items.map((item) => (
                      <a
                        key={item.href}
                        href={item.href}
                        className={item.href === current ? "on" : undefined}
                        aria-current={item.href === current ? "page" : undefined}
                      >
                        <span className="rail-icon" data-tone={toneOf(item.href)}>{item.icon}</span>
                        <span className="pmenu-label">{item.label}</span>
                      </a>
                    ))}
                  </div>
                </Fragment>
              ))}
            </nav>
            <a className="pmenu-signout" href="/api/auth/logout" onClick={signOutHere}>
              Sign out
            </a>
          </div>
        </div>
      ) : null}
    </>
  );
}
