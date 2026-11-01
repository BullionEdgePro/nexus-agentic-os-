"use client";

import { useEffect, useState } from "react";
import { isMuted, play, setMuted } from "@/lib/sound";

/**
 * The speaker in the dock's foot (spec 2026-11-01-cream-foundation-design.md §4).
 *
 * The server cannot read the browser's choice, so the first frame shows sound
 * on — the default — and the effect corrects it to what was saved. Turning
 * sound back on answers with a tick, so the person hears that it worked.
 */
export function SoundToggle() {
  const [muted, setMutedState] = useState(false);

  useEffect(() => setMutedState(isMuted()), []);

  function toggle() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) play("tick");
  }

  return (
    <button
      type="button"
      className="nx-sound"
      onClick={toggle}
      role="switch"
      aria-checked={!muted}
      aria-label={muted ? "Sound off — turn on" : "Sound on — mute"}
      title={muted ? "Turn sound on" : "Mute sounds"}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 9.5v5h3.5L12 19V5L7.5 9.5H4Z" />
        {muted ? <path d="m16 9.5 5 5m0-5-5 5" /> : <path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />}
      </svg>
    </button>
  );
}
