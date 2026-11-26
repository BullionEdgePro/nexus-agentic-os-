"use client";

import type { ReactNode } from "react";

/**
 * An add form folded behind one button (26 Nov 2026, staff-first compact): the
 * page shows its list first, and "+ Add …" opens the same form in place, with
 * Cancel beside it. The page owns `open`, so it can start open (`?add=1`, as
 * My Day's shortcuts link) and close after a save; what was typed stays in the
 * page's own state when Cancel folds it.
 * Spec: docs/superpowers/specs/2026-11-26-staff-first-compact-design.md §4.2
 */
export function AddFold({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  if (!open) {
    return (
      <button type="button" className="add-fold-open" aria-expanded="false" onClick={() => onOpenChange(true)}>
        + {label}
      </button>
    );
  }
  return (
    <div className="add-fold">
      {children}
      <button type="button" className="add-fold-cancel" aria-expanded="true" onClick={() => onOpenChange(false)}>
        Cancel
      </button>
    </div>
  );
}
