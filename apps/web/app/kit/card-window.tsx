"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { play } from "@/lib/sound";
import { trapTab } from "@/lib/kit/focus";
import { originOf } from "@/lib/kit/place";

/**
 * A card grows into a centred window over a blurred page (2 Nov 2026, Cream
 * pages 2a), as the video's deal card does. Closes on ✕, Escape and a click
 * outside; keyboard focus moves in, stays in, and returns to the card.
 *
 * Open it with `openFromCard(card, () => setOpen(true))`: where the browser has
 * View Transitions (and motion is welcome) the card itself morphs into the
 * window; elsewhere the window scales in from the card's position.
 */
/**
 * Where windows and panels mount: the console shell itself. Inside the page
 * they would sit in the shell's main column, a stacking context of its own, and
 * the rail would stay sharp above the scrim. The shell also carries the tokens
 * and fonts. Without a document (the server, the render tests) they render in
 * place.
 */
export function kitLayer(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(".deck-root.shell") ?? document.body;
}

export function openFromCard(card: HTMLElement | null, open: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  const motion = window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
  if (!card || !doc.startViewTransition || !motion) {
    open();
    return;
  }
  card.style.setProperty("view-transition-name", "kit-window");
  doc.startViewTransition(() => {
    card.style.removeProperty("view-transition-name");
    flushSync(open);
  });
}

export function CardWindow({
  open,
  title,
  onClose,
  origin,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** The card it opened from: it grows from there, and focus returns there. */
  origin?: HTMLElement | null;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    play("pop");
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      } else if (box.current) {
        trapTab(box.current, event);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      origin?.focus();
    };
    // Opening is the event; the card it came from is read once, at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  const grow =
    origin && typeof window !== "undefined"
      ? originOf(origin.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight })
      : { x: 50, y: 50 };

  const scrim = (
    <div
      className="kit-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        className="kit-window"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        style={{ transformOrigin: `${grow.x}% ${grow.y}%` }}
      >
        <button type="button" className="kit-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
        {children}
      </div>
    </div>
  );
  const layer = kitLayer();
  return layer ? createPortal(scrim, layer) : scrim;
}
