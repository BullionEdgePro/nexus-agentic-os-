"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { play } from "@/lib/sound";
import { elapsedMs, INITIAL, micOn, RECORDER, step } from "@/lib/team-chat/recorder";
import { foldPeaks, formatClock } from "@/lib/team-chat/waveform";

/**
 * The 🎤 button: press and hold to record a voice note (2 Nov 2026).
 * Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §2
 *
 * Touch: hold to record, let go to send, slide left to cancel, slide up to lock
 * and keep recording hands-free. Mouse: a click opens the hands-free bar; a
 * longer press behaves like touch. Every rule is lib/team-chat/recorder.ts —
 * this component feeds it pointer, timer and visibility events and acts on the
 * phase that comes back. The one thing it does on its own: whenever the phase
 * is one where the microphone should be off, it is turned off, so the phone's
 * mic light never stays on after a send, a cancel, an error or leaving the chat.
 */

const TYPES = ["audio/mp4", "audio/webm;codecs=opus", "audio/ogg;codecs=opus"];
const DENIED = "Nexus can't use your microphone. Allow it in your browser's site settings, then try again.";
const SETUP = "Microphone is on. Now press and hold to record.";

type Note = { blob: Blob; mime: string; durationMs: number; waveform: number[] };

export function VoiceRecorder({ onSend, disabled }: { onSend: (note: Note) => void; disabled: boolean }) {
  const [state, dispatch] = useReducer(step, INITIAL);
  const [now, setNow] = useState(0);
  const [hint, setHint] = useState("");
  const stateRef = useRef(state);
  stateRef.current = state;

  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const mime = useRef("audio/webm");
  const levels = useRef<number[]>([]);
  const audio = useRef<AudioContext | null>(null);
  const sampler = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const startedAt = useRef<number | null>(null);
  const reviewBlob = useRef<Blob | null>(null);

  const at = () => performance.now();

  /** Everything the microphone holds, let go. Safe to call twice. */
  const releaseMic = useCallback(() => {
    if (sampler.current) clearInterval(sampler.current);
    sampler.current = undefined;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void audio.current?.close().catch(() => undefined);
    audio.current = null;
  }, []);

  /** Stop the recorder and hand back what it recorded (null when it never started). */
  const finishRecording = useCallback(
    () =>
      new Promise<Blob | null>((resolve) => {
        const rec = recorder.current;
        recorder.current = null;
        if (!rec) return resolve(reviewBlob.current);
        const done = () => resolve(chunks.current.length ? new Blob(chunks.current, { type: mime.current }) : null);
        if (rec.state === "inactive") return done();
        rec.addEventListener("stop", done, { once: true });
        try {
          rec.stop();
        } catch {
          done();
        }
      }),
    []
  );

  async function openMic() {
    if (typeof window === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setHint("This browser can't record voice notes. Type a message instead.");
      dispatch({ type: "reset" });
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      dispatch({ type: "denied" });
      return;
    }
    // Let go before the microphone was ready — the first time, the browser's
    // permission question takes the press. Nothing was recorded; say what next.
    if (!micOn(stateRef.current.phase)) {
      media.getTracks().forEach((t) => t.stop());
      setHint(SETUP);
      dispatch({ type: "reset" });
      return;
    }
    stream.current = media;
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
    const rec = new MediaRecorder(media, type ? { mimeType: type, audioBitsPerSecond: 48_000 } : undefined);
    mime.current = rec.mimeType || type || "audio/webm";
    chunks.current = [];
    levels.current = [];
    reviewBlob.current = null;
    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };
    rec.start(250);
    recorder.current = rec;
    startedAt.current = at();

    // The waveform: the loudness of each 60 ms, folded into bars on send.
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(media).connect(analyser);
      audio.current = context;
      const buffer = new Uint8Array(analyser.fftSize);
      sampler.current = setInterval(() => {
        if (stateRef.current.phase === "paused") return;
        analyser.getByteTimeDomainData(buffer);
        let peak = 0;
        for (const v of buffer) peak = Math.max(peak, Math.abs(v - 128) / 128);
        levels.current.push(peak);
      }, 60);
    } catch {
      // No waveform; the note still records and sends with a flat one.
    }
    // A call or another app taking the microphone ends the track.
    media.getAudioTracks()[0]?.addEventListener("ended", () => dispatch({ type: "browser-cancel", at: at() }));
    play("tick");
  }

  // ---- the phase decides what happens ------------------------------------------
  useEffect(() => {
    const phase = state.phase;
    if (phase === "paused") recorder.current?.pause();
    if (phase === "locked" && recorder.current?.state === "paused") recorder.current.resume();
    if (!micOn(state.phase)) {
      void (async () => {
        const blob = phase === "idle" || phase === "denied" ? null : await finishRecording();
        releaseMic();
        // The time actually recorded: the clock started at the press, the
        // recorder when the microphone was ready.
        const lag = startedAt.current !== null ? Math.max(0, startedAt.current - stateRef.current.startedAt) : 0;
        const durationMs = Math.max(0, state.recordedMs - lag);
        if (phase === "sending") {
          if (!blob || blob.size === 0) {
            setHint(startedAt.current === null ? SETUP : "Nothing was recorded. Try again.");
          } else if (durationMs < RECORDER.minMs) {
            setHint("Hold to record, release to send");
          } else {
            onSend({ blob, mime: mime.current, durationMs, waveform: foldPeaks(levels.current, 64) });
          }
          startedAt.current = null;
          dispatch({ type: "reset" });
        } else if (phase === "review") {
          reviewBlob.current = blob;
          if (!blob || blob.size === 0) {
            setHint(startedAt.current === null ? SETUP : "Nothing was recorded. Try again.");
            startedAt.current = null;
            dispatch({ type: "reset" });
          }
        } else if (phase === "cancelled") {
          play("whoosh");
          reviewBlob.current = null;
          startedAt.current = null;
          setTimeout(() => dispatch({ type: "reset" }), 450);
        } else if (phase === "too-short") {
          reviewBlob.current = null;
          startedAt.current = null;
          setHint("Hold to record, release to send");
          dispatch({ type: "reset" });
        } else if (phase === "denied") {
          setHint(DENIED);
          dispatch({ type: "reset" });
        }
      })();
    }
    // Only phase changes drive this; recordedMs is read from the same state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase]);

  // The clock, and the five-minute stop.
  useEffect(() => {
    if (state.phase !== "holding" && state.phase !== "locked") return;
    const timer = setInterval(() => {
      const t = at();
      setNow(t);
      dispatch({ type: "tick", at: t });
    }, 200);
    return () => clearInterval(timer);
  }, [state.phase]);

  // A hidden tab or locked screen pauses into review.
  useEffect(() => {
    const onHide = () => {
      if (document.hidden) dispatch({ type: "hidden", at: at() });
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  // Leaving the chat: let the microphone go.
  useEffect(
    () => () => {
      try {
        recorder.current?.stop();
      } catch {
        // already stopped
      }
      releaseMic();
    },
    [releaseMic]
  );

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(""), hint === DENIED ? 8000 : 2600);
    return () => clearTimeout(timer);
  }, [hint]);

  // ---- input -------------------------------------------------------------------
  function onPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (disabled || event.button > 0) return;
    if (stateRef.current.phase !== "idle") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setHint("");
    dispatch({ type: "press", at: at(), x: event.clientX, y: event.clientY, pointer: event.pointerType === "mouse" ? "mouse" : "touch" });
    void openMic();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>) {
    if (disabled || (event.key !== "Enter" && event.key !== " ")) return;
    if (stateRef.current.phase !== "idle") return;
    event.preventDefault();
    // The keyboard gets the hands-free bar, as a mouse click does.
    const t = at();
    dispatch({ type: "press", at: t, x: 0, y: 0, pointer: "mouse" });
    dispatch({ type: "release", at: t });
    void openMic();
  }

  const phase = state.phase;
  const clock = formatClock(phase === "holding" || phase === "locked" ? elapsedMs(state, now || at()) : state.recordedMs);
  const lockProgress = phase === "holding" ? Math.min(1, Math.max(0, -state.dy / RECORDER.lockPx)) : 0;
  const cancelProgress = phase === "holding" ? Math.min(1, Math.max(0, -state.dx / RECORDER.cancelPx)) : 0;

  const hands = phase === "locked" || phase === "paused" || phase === "review";

  return (
    <>
      {phase === "holding" ? (
        <div className="tc-rec-bar" aria-live="polite">
          <span className="tc-rec-dot" aria-hidden="true" />
          <span className="tc-rec-clock">{clock}</span>
          <span className="tc-rec-slide" style={{ opacity: 1 - cancelProgress * 0.7, transform: `translateX(${-cancelProgress * 24}px)` }}>
            ‹ Slide to cancel
          </span>
          <span className="tc-rec-lock" aria-hidden="true" style={{ transform: `translateY(${-lockProgress * 16}px)` }}>
            🔒
          </span>
        </div>
      ) : null}
      {hands ? (
        <div className="tc-rec-bar locked" aria-live="polite">
          <button type="button" className="tc-icon-btn" aria-label="Delete recording" onClick={() => dispatch({ type: "delete" })}>
            🗑
          </button>
          {phase !== "review" ? <span className={`tc-rec-dot${phase === "paused" ? " paused" : ""}`} aria-hidden="true" /> : null}
          <span className="tc-rec-clock">{clock}</span>
          <span className="tc-rec-label">
            {phase === "paused"
              ? "Paused"
              : phase === "review"
                ? state.reviewReason === "limit"
                  ? "5 minutes is the most — send it or delete it"
                  : "Recording stopped — send it or delete it"
                : "Recording"}
          </span>
          {phase === "locked" ? (
            <button type="button" className="tc-icon-btn" aria-label="Pause recording" onClick={() => dispatch({ type: "pause", at: at() })}>
              ⏸
            </button>
          ) : phase === "paused" ? (
            <button type="button" className="tc-icon-btn" aria-label="Resume recording" onClick={() => dispatch({ type: "resume", at: at() })}>
              ⏺
            </button>
          ) : null}
        </div>
      ) : null}
      {hint && !hands && phase !== "holding" ? (
        <p className={`tc-rec-note${hint === DENIED ? " bad" : ""}`} role="status">
          {hint}
        </p>
      ) : null}
      {hands ? (
        <button type="button" className="tc-round" aria-label="Send voice note" onClick={() => dispatch({ type: "send", at: at() })}>
          ➤
        </button>
      ) : (
        <button
          type="button"
          className={`tc-round${phase === "holding" ? " recording" : ""}`}
          aria-label="Record a voice note"
          title="Hold to record, release to send"
          disabled={disabled}
          onPointerDown={onPointerDown}
          onPointerMove={(event) => {
            if (stateRef.current.phase === "holding") dispatch({ type: "move", x: event.clientX, y: event.clientY });
          }}
          onPointerUp={() => dispatch({ type: "release", at: at() })}
          onPointerCancel={() => dispatch({ type: "browser-cancel", at: at() })}
          onKeyDown={onKeyDown}
          onContextMenu={(event) => event.preventDefault()}
        >
          🎤
        </button>
      )}
    </>
  );
}
