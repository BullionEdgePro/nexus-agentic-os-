"use client";

/**
 * The 📎 button (2 Nov 2026): camera, photos and documents — drawn in full by a
 * later step of the staff chat build; until then it shows, and does nothing.
 */
export function AttachButton({ disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  return (
    <button type="button" className="tc-icon-btn" aria-label="Attach" disabled={disabled || true}>
      📎
    </button>
  );
}
