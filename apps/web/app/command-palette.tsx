"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NAV } from "@/lib/nav";
import { getMyClients, type MyClient } from "@/lib/api";
import "./command-palette.css";

/**
 * One search for everything a person needs to reach — ⌘K, or the box in the rail.
 *
 * ============================================================
 * TWO THINGS IT FINDS, AND WHY BOTH
 * ============================================================
 *
 * It began as a keyboard jump between SCREENS, drawing from the one nav list the
 * rail uses so it can never offer a door the role cannot open. That is still
 * here, and still instant — no backend, the screens a person already has.
 *
 * But "find everything they need" is mostly PEOPLE for a staff member, not
 * screens: the client who just wrote in, by name or number. So for staff the
 * same box also searches their own client book (live, debounced), and a hit
 * opens the book filtered to that person. It is gated to the employee role
 * because `/api/my/clients` is a person's own book — an operator has none, and
 * asking would 403 — so the operator's palette stays screens-only, unchanged.
 *
 * Opened two ways for one reason: discoverability. ⌘K is fast once you know it
 * and invisible until you do, so the rail carries a visible box that dispatches
 * `nexus:open-search`. One overlay, two triggers.
 */

type ScreenHit = { kind: "screen"; href: string; label: string; icon: ReactNode };
type ClientHit = { kind: "client"; href: string; label: string; sub: string | null };
type Hit = ScreenHit | ClientHit;

const clientHref = (c: MyClient) =>
  `/deck/my-clients?q=${encodeURIComponent(c.displayName || c.waId)}`;

export function CommandPalette({ role }: { role: "operator" | "employee" }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [clients, setClients] = useState<MyClient[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Screens: the same list the rail draws from, hiding the same doors the role
  // cannot open, filtered by the query as you type.
  const screenHits = useMemo<ScreenHit[]>(() => {
    const visible =
      role === "operator" ? NAV.filter((i) => !i.staffOnly) : NAV.filter((i) => !i.operatorOnly);
    const query = q.trim().toLowerCase();
    const matches = query ? visible.filter((i) => i.label.toLowerCase().includes(query)) : visible;
    return matches.map((i) => ({ kind: "screen", href: i.href, label: i.label, icon: i.icon }));
  }, [role, q]);

  // Clients: staff only, and only once there is something to search for — an
  // empty query would fetch the whole book into a jump list nobody asked for.
  useEffect(() => {
    if (!open || role !== "employee") return;
    const query = q.trim();
    if (!query) {
      setClients([]);
      return;
    }
    let cancelled = false;
    // Debounced so a search does not fire a request per keystroke.
    const timer = setTimeout(() => {
      getMyClients(query)
        .then((res) => {
          if (!cancelled) setClients(res.clients.slice(0, 8));
        })
        // Swallowed: a search that cannot reach the book still finds screens, and
        // an error thrown here would take the whole palette down with it.
        .catch(() => {
          if (!cancelled) setClients([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, role, q]);

  const clientHits = useMemo<ClientHit[]>(
    () =>
      clients.map((c) => ({
        kind: "client",
        href: clientHref(c),
        label: c.displayName || c.waId,
        sub: c.company || (c.displayName ? `+${c.waId}` : null),
      })),
    [clients]
  );

  // One flat list so the arrow keys move through screens and people alike.
  const items = useMemo<Hit[]>(() => [...screenHits, ...clientHits], [screenHits, clientHits]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    }
    // The visible box in the rail opens the same overlay — one search, two ways in.
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("nexus:open-search", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("nexus:open-search", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setQ("");
    setClients([]);
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
      <div className="cmdp" role="dialog" aria-label="Search">
        <input
          ref={inputRef}
          className="cmdp-input"
          placeholder={role === "employee" ? "Search clients and screens…" : "Search screens…"}
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
            <li className="cmdp-empty">Nothing matches “{q}”.</li>
          ) : (
            items.map((item, i) => {
              // A quiet section label when the kind changes, so screens and
              // people read as two answers rather than one mixed pile.
              const heading =
                i === 0 || items[i - 1].kind !== item.kind ? (item.kind === "client" ? "Clients" : "Screens") : null;
              return (
                <li key={`${item.kind}:${item.href}`}>
                  {heading ? (
                    <span className="cmdp-group" aria-hidden="true">
                      {heading}
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={`cmdp-item${i === active ? " on" : ""}`}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(item.href)}
                  >
                    <span className="cmdp-ic">
                      {item.kind === "screen" ? (
                        item.icon
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="8" r="3.4" />
                          <path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6" />
                        </svg>
                      )}
                    </span>
                    <span className="cmdp-text">
                      <span className="cmdp-label">{item.label}</span>
                      {item.kind === "client" && item.sub ? (
                        <span className="cmdp-sub">{item.sub}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })
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
