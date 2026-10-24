"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Snooze (24 Oct 2026, Focus workspace): put a chat aside until a time. It
 * leaves every waiting count until then, or until the customer writes again.
 * Times are in the reader's own clock: "tomorrow 9:00" means their morning.
 */
export function snoozePresets(now: Date = new Date()): { label: string; until: Date }[] {
  const inHours = (h: number) => new Date(now.getTime() + h * 3_600_000);
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { label: "1 hour", until: inHours(1) },
    { label: "3 hours", until: inHours(3) },
    { label: "Tomorrow 9:00", until: tomorrow },
    { label: "Next week (Monday 9:00)", until: monday },
  ];
}

export function SnoozeMenu({
  open,
  onOpenChange,
  onSnooze,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSnooze: (until: Date) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const [presets, setPresets] = useState(() => snoozePresets());

  useEffect(() => {
    if (!open) return;
    setPresets(snoozePresets());
    function away(event: MouseEvent) {
      if (box.current && !box.current.contains(event.target as Node)) onOpenChange(false);
    }
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open, onOpenChange]);

  return (
    <div className="ibx-snooze" ref={box}>
      <button
        type="button"
        className="ibx-notcust"
        aria-expanded={open}
        title="Put this chat aside until a time (S)"
        onClick={() => onOpenChange(!open)}
      >
        <span>Snooze</span>
      </button>
      {open ? (
        <div className="ibx-snooze-pop" role="menu" aria-label="Snooze until">
          {presets.map((preset) => (
            <button
              key={preset.label}
              type="button"
              role="menuitem"
              onClick={() => {
                onSnooze(preset.until);
                onOpenChange(false);
              }}
            >
              <span>{preset.label}</span>
              <small>
                {preset.until.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
              </small>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
