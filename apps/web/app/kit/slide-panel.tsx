"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { play } from "@/lib/sound";
import { trapTab } from "@/lib/kit/focus";
import { kitLayer } from "./card-window";

/**
 * A panel that slides in from the right over a frosted page (2 Nov 2026, Cream
 * pages 2a), as the video's invoice does. Full screen on a phone. Closes on ✕,
 * Escape and a click outside; focus moves in, stays in, and goes back to what
 * had it before.
 */
export function SlidePanel({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    play("whoosh");
    const before = document.activeElement as HTMLElement | null;
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
      before?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  const scrim = (
    <div
      className="kit-scrim side"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={box} className="kit-panel" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <button type="button" className="kit-close" aria-label="Close" onClick={onClose}>
          ✕
        </button>
        {children}
      </div>
    </div>
  );
  // On the console shell, above its rail (see kitLayer).
  const layer = kitLayer();
  return layer ? createPortal(scrim, layer) : scrim;
}
