"use client";

import { useRef, useState, type ReactNode } from "react";

/**
 * Swipe a chat on a phone (24 Oct 2026, Focus workspace): right to resolve,
 * left to snooze 3 hours. Touch only — a mouse drag does nothing — and it
 * takes 96px of travel, so a scroll that drifts sideways never files a chat.
 * The tap that ends a swipe does not also open the chat. The page shows an
 * Undo for six seconds after either action.
 */
export const SWIPE_ACTION_PX = 96;

export function SwipeRow({
  children,
  onResolve,
  onSnooze,
  disabled,
}: {
  children: ReactNode;
  onResolve: () => void;
  onSnooze: () => void;
  disabled?: boolean;
}) {
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number; id: number } | null>(null);
  const moved = useRef(false);
  const horizontal = useRef<boolean | null>(null);

  if (disabled) return <>{children}</>;

  return (
    <div
      className={`ibx-swipe${dx > 0 ? " right" : dx < 0 ? " left" : ""}`}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        start.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        moved.current = false;
        horizontal.current = null;
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s || s.id !== e.pointerId) return;
        const x = e.clientX - s.x;
        const y = e.clientY - s.y;
        // Decide once whether this is a swipe or a scroll.
        if (horizontal.current === null && (Math.abs(x) > 8 || Math.abs(y) > 8)) {
          horizontal.current = Math.abs(x) > Math.abs(y);
        }
        if (!horizontal.current) return;
        moved.current = true;
        setDx(Math.max(-160, Math.min(160, x)));
      }}
      onPointerUp={() => {
        const travel = dx;
        start.current = null;
        setDx(0);
        if (travel >= SWIPE_ACTION_PX) onResolve();
        else if (travel <= -SWIPE_ACTION_PX) onSnooze();
      }}
      onPointerCancel={() => {
        start.current = null;
        setDx(0);
      }}
      onClickCapture={(e) => {
        if (moved.current) {
          e.preventDefault();
          e.stopPropagation();
          moved.current = false;
        }
      }}
    >
      <span className="ibx-swipe-under ibx-swipe-resolve" aria-hidden="true">
        Resolve
      </span>
      <span className="ibx-swipe-under ibx-swipe-snooze" aria-hidden="true">
        Snooze 3h
      </span>
      <div className="ibx-swipe-top" style={{ transform: dx ? `translateX(${dx}px)` : undefined }}>
        {children}
      </div>
    </div>
  );
}
