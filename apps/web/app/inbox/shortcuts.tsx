"use client";

import { useEffect, useRef } from "react";

/**
 * Inbox keyboard shortcuts (24 Oct 2026, Focus workspace).
 *
 * NEVER WHILE WRITING. A key pressed in the reply box, a note, a search field
 * or anything editable is text, not a command: "e" in "please" must never
 * resolve the chat. Modified keys (Ctrl, Alt, Meta) are left to the browser
 * and the command bar. Every shortcut is also a visible button.
 */
export type ShortcutHandlers = Partial<Record<"j" | "k" | "r" | "e" | "s" | "a" | "x" | "t" | "?", () => void>>;

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function useInboxShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      // An open dialog (the command bar, a menu) owns the keyboard.
      if (document.querySelector('[role="dialog"][aria-modal="true"], .cmdp-backdrop')) return;
      const key = event.key === "?" ? "?" : event.key.toLowerCase();
      const run = ref.current[key as keyof ShortcutHandlers];
      if (!run) return;
      event.preventDefault();
      run();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

const SHEET: [string, string][] = [
  ["Search or do anything", "Ctrl K"],
  ["Next / previous chat", "J / K"],
  ["Write a reply", "R"],
  ["Send", "Enter"],
  ["New line", "Shift Enter"],
  ["Resolve", "E"],
  ["Snooze", "S"],
  ["Ask a colleague", "A"],
  ["Not a customer", "X"],
  ["Team chat", "T"],
  ["Quick reply", "/ in the reply box"],
  ["This list", "?"],
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" || event.key === "?") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="ibx-keys-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ibx-keys" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div className="ibx-keys-head">
          <h2>Shortcuts</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <dl>
          {SHEET.map(([what, key]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>
                <kbd>{key}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p>Every shortcut is also a button, so nobody has to learn them.</p>
      </div>
    </div>
  );
}
