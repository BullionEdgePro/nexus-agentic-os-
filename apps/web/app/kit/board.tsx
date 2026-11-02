"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { play } from "@/lib/sound";
import { columnAt, dropTarget, type Box } from "@/lib/kit/drag";
import type { Tone } from "@/lib/kit/wait-band";

/**
 * A board you drag by finger or mouse (2 Nov 2026, Cream pages 2a), as the
 * video's pipeline: coloured columns, coloured cards, a card that lifts and
 * tilts while it follows the pointer, and the column under it opening a space.
 *
 * Written on Pointer Events rather than the browser's own drag and drop, which
 * phones do not have. A mouse starts a drag after a few pixels of movement, so
 * a click still opens the card. A finger starts one after a short hold, so a
 * swipe still scrolls the board; once it has started, the page stops scrolling
 * under the finger. The hook never moves a card itself: it asks `canDrop`, then
 * calls `onDrop`, and the page shows what the server saved — so a refused or
 * failed drop leaves the card exactly where it was.
 */

const DRAG_START_PX = 6;
const TOUCH_HOLD_MS = 250;

export function BoardColumn({
  id,
  tone,
  title,
  count,
  active = false,
  children,
}: {
  id: string;
  tone: Tone;
  title: string;
  count: number;
  /** A card is being dragged over this column and may drop here. */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <section className={`kit-col tone-head-${tone}${active ? " active" : ""}`} data-column={id} aria-label={`${title}, ${count}`}>
      <header className="kit-col-head">
        <span className="kit-col-dot" aria-hidden="true" />
        <h3>{title}</h3>
        <span className="kit-col-count">{count}</span>
      </header>
      <div className="kit-col-cards">{children}</div>
      <div className="kit-col-drop" aria-hidden="true" />
    </section>
  );
}

/**
 * The card only starts a press. Everything after — the moves, the release, a
 * cancel — is heard by the window, because a quick flick leaves the card before
 * the drag has begun, and its release can land anywhere on the page.
 */
export type CardHandlers = {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
};

export function BoardCard({
  id,
  tone,
  title,
  lines,
  onOpen,
  label,
  handlers,
  dragging = false,
}: {
  id: string;
  tone: Tone;
  title: string;
  lines: string[];
  onOpen: (card: HTMLElement) => void;
  label: string;
  handlers?: CardHandlers;
  dragging?: boolean;
}) {
  return (
    <button
      type="button"
      className={`kit-card tone-${tone} kit-board-card${handlers ? " can-drag" : ""}${dragging ? " kit-placeholder" : ""}`}
      aria-label={label}
      // Lets a page find the card again after it moves columns (and so becomes
      // a new element), to put the keyboard back on it.
      data-card={id}
      onClick={(event) => onOpen(event.currentTarget)}
      {...handlers}
    >
      <span className="kit-card-title" dir="auto">
        {title}
      </span>
      {lines.map((line, i) => (
        <span key={i} className="kit-card-sub" dir="auto">
          {line}
        </span>
      ))}
    </button>
  );
}

type Press = {
  id: string;
  from: string;
  pointerId: number;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  el: HTMLElement;
  touch: boolean;
  started: boolean;
  ghost: HTMLElement | null;
  hold: ReturnType<typeof setTimeout> | null;
  stopScroll: ((event: TouchEvent) => void) | null;
  /** Lets go of the window's listeners for this press. */
  detach: () => void;
};

/** How long after a drag ends its click is swallowed, wherever the browser sends it. */
const SWALLOW_CLICK_MS = 400;

function columnBoxes(): Box[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-column]")).map((el) => {
    const r = el.getBoundingClientRect();
    return { key: el.dataset.column!, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });
}

export function useBoardDrag({
  canDrop,
  onDrop,
}: {
  canDrop: (cardId: string, from: string, to: string) => boolean;
  onDrop: (cardId: string, from: string, to: string) => Promise<void>;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const press = useRef<Press | null>(null);
  const suppressClickUntil = useRef(0);
  const latest = useRef({ canDrop, onDrop });
  latest.current = { canDrop, onDrop };

  const targetAt = (p: Press, x: number, y: number) => {
    const to = columnAt(x, y, columnBoxes());
    return dropTarget(p.from, to, to ? latest.current.canDrop(p.id, p.from, to) : false);
  };

  const end = useCallback(() => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    p.detach();
    if (p.hold) clearTimeout(p.hold);
    if (p.stopScroll) document.removeEventListener("touchmove", p.stopScroll);
    p.ghost?.remove();
    setDragging(null);
    setOver(null);
  }, []);

  // Escape puts the card back.
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") end();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dragging, end]);

  useEffect(() => end, [end]);

  function begin(p: Press) {
    p.started = true;
    // From this moment the page must not scroll under the finger — attached
    // now, not after a render, so the very first move is already held.
    p.stopScroll = (event: TouchEvent) => event.preventDefault();
    document.addEventListener("touchmove", p.stopScroll, { passive: false });
    try {
      p.el.setPointerCapture(p.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still follows moves.
    }
    const rect = p.el.getBoundingClientRect();
    const ghost = p.el.cloneNode(true) as HTMLElement;
    ghost.classList.add("kit-ghost");
    ghost.removeAttribute("id");
    ghost.setAttribute("aria-hidden", "true");
    Object.assign(ghost.style, { width: `${rect.width}px`, left: `${rect.left}px`, top: `${rect.top}px` });
    document.body.append(ghost);
    p.ghost = ghost;
    if (p.touch) navigator.vibrate?.(10);
    setDragging(p.id);
  }

  function follow(p: Press, x: number, y: number) {
    if (p.ghost) {
      const rect = p.el.getBoundingClientRect();
      p.ghost.style.transform = `translate(${x - p.offsetX - rect.left}px, ${y - p.offsetY - rect.top}px) rotate(3deg)`;
    }
    setOver(targetAt(p, x, y));
  }

  function onMove(event: PointerEvent) {
    const p = press.current;
    if (!p || p.pointerId !== event.pointerId) return;
    if (!p.started) {
      const moved = Math.hypot(event.clientX - p.x, event.clientY - p.y);
      if (moved < DRAG_START_PX) return;
      // A finger that moves before the hold is a scroll, not a drag.
      if (p.touch) {
        end();
        return;
      }
      begin(p);
    }
    follow(p, event.clientX, event.clientY);
  }

  function onUp(event: PointerEvent) {
    const p = press.current;
    if (!p || p.pointerId !== event.pointerId) return;
    if (!p.started) {
      end();
      return;
    }
    // The click that ends a drag lands wherever the browser decides — usually
    // not on the card — so it is swallowed by time rather than by waiting for it.
    suppressClickUntil.current = Date.now() + SWALLOW_CLICK_MS;
    const to = targetAt(p, event.clientX, event.clientY);
    const { id, from } = p;
    end();
    if (!to) return;
    latest.current
      .onDrop(id, from, to)
      .then(() => play("chime"))
      .catch(() => undefined);
  }

  function onCancel(event: PointerEvent) {
    if (press.current && press.current.pointerId === event.pointerId) end();
  }

  function cardHandlers(cardId: string, column: string): CardHandlers {
    return {
      onPointerDown(event) {
        if (event.button > 0 || press.current) return;
        const el = event.currentTarget;
        const rect = el.getBoundingClientRect();
        // The window hears the rest of the press (see CardHandlers).
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        const p: Press = {
          id: cardId,
          from: column,
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          offsetX: event.clientX - rect.left,
          offsetY: event.clientY - rect.top,
          el,
          touch: event.pointerType !== "mouse",
          started: false,
          ghost: null,
          hold: null,
          stopScroll: null,
          detach: () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
          },
        };
        press.current = p;
        if (p.touch) {
          p.hold = setTimeout(() => {
            if (press.current === p && !p.started) begin(p);
          }, TOUCH_HOLD_MS);
        }
      },
      onClickCapture(event) {
        // The click that ends a drag never also opens the card.
        if (Date.now() < suppressClickUntil.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
    };
  }

  return { dragging, over, cardHandlers };
}
