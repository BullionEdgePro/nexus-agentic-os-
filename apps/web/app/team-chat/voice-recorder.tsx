"use client";

/**
 * The 🎤 button (2 Nov 2026). Press and hold to record a voice note — drawn in
 * full by the next step of the staff chat build; until then it shows, and does
 * nothing, so the message box already has its WhatsApp shape.
 */
export function VoiceRecorder({
  disabled,
}: {
  onSend: (note: { blob: Blob; mime: string; durationMs: number; waveform: number[] }) => void;
  disabled: boolean;
}) {
  return (
    <button type="button" className="tc-round" aria-label="Record a voice note" disabled={disabled || true}>
      🎤
    </button>
  );
}
