/**
 * The voice note recorder's rules (2 Nov 2026), with no browser in them.
 * Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §2
 *
 * WhatsApp's mic: press and hold to record, let go to send, slide left to
 * cancel, slide up to lock and keep recording hands-free. Each of those, and
 * every way a phone can interrupt them (a scroll stealing the press, the
 * screen locking, a call), is one row of the table below, so each is tested
 * without a microphone. The component only feeds events in and acts on the
 * phase that comes out: it records while `micOn`, and lets the microphone go
 * the moment it is not.
 *
 * Two promises the table keeps: a recording is never lost by an
 * interruption (it goes to review, not to the bin), and it is never sent by
 * one (only a deliberate release or Send sends).
 */

export const RECORDER = { cancelPx: 96, lockPx: 72, clickMs: 300, minMs: 1000, maxMs: 300_000 } as const;

export type Phase =
  | "idle"
  | "holding"
  | "locked"
  | "paused"
  | "review"
  | "sending"
  | "cancelled"
  | "too-short"
  | "denied";

export interface RecorderState {
  phase: Phase;
  startedAt: number;
  pointer: "touch" | "mouse" | null;
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  /** Recorded time before the current segment (pauses excluded). */
  recordedMs: number;
  /** When the current recording segment began; null while not recording. */
  segmentStart: number | null;
  reviewReason: "limit" | "interrupted" | "stopped" | null;
}

export type RecorderEvent =
  | { type: "press"; at: number; x: number; y: number; pointer: "touch" | "mouse" }
  | { type: "move"; x: number; y: number }
  | { type: "release"; at: number }
  | { type: "browser-cancel"; at: number }
  | { type: "tick"; at: number }
  | { type: "hidden"; at: number }
  | { type: "pause"; at: number }
  | { type: "resume"; at: number }
  | { type: "stop"; at: number }
  | { type: "send"; at: number }
  | { type: "delete" }
  | { type: "denied" }
  | { type: "reset" };

export const INITIAL: RecorderState = {
  phase: "idle",
  startedAt: 0,
  pointer: null,
  x0: 0,
  y0: 0,
  dx: 0,
  dy: 0,
  recordedMs: 0,
  segmentStart: null,
  reviewReason: null,
};

/** Recorded time at `now`, pauses excluded. */
export function elapsedMs(state: RecorderState, now: number): number {
  return state.recordedMs + (state.segmentStart === null ? 0 : Math.max(0, now - state.segmentStart));
}

/** Whether the microphone should be open. Every other phase lets it go. */
export function micOn(phase: Phase): boolean {
  return phase === "holding" || phase === "locked" || phase === "paused";
}

const recording = (phase: Phase) => phase === "holding" || phase === "locked";
const live = (phase: Phase) => phase === "holding" || phase === "locked" || phase === "paused";

/** The clock stopped at `at`: the segment so far is folded into recordedMs. */
function stopped(state: RecorderState, at: number): RecorderState {
  return { ...state, recordedMs: Math.min(elapsedMs(state, at), RECORDER.maxMs), segmentStart: null };
}

function finish(state: RecorderState, at: number): RecorderState {
  const done = stopped(state, at);
  return { ...done, phase: done.recordedMs < RECORDER.minMs ? "too-short" : "sending" };
}

export function step(state: RecorderState, event: RecorderEvent): RecorderState {
  if (event.type === "reset") return INITIAL;
  if (event.type === "denied") return { ...INITIAL, phase: "denied" };

  switch (event.type) {
    case "press":
      if (state.phase !== "idle") return state;
      return {
        ...INITIAL,
        phase: "holding",
        startedAt: event.at,
        pointer: event.pointer,
        x0: event.x,
        y0: event.y,
        segmentStart: event.at,
      };

    case "move": {
      if (state.phase !== "holding") return state;
      const dx = event.x - state.x0;
      const dy = event.y - state.y0;
      if (dx <= -RECORDER.cancelPx) return { ...state, dx, dy, phase: "cancelled", segmentStart: null };
      if (dy <= -RECORDER.lockPx) return { ...state, dx, dy, phase: "locked" };
      return { ...state, dx, dy };
    }

    case "release":
      if (state.phase !== "holding") return state;
      // A mouse click (not a hold) opens the hands-free bar, as on WhatsApp Web.
      if (state.pointer === "mouse" && event.at - state.startedAt < RECORDER.clickMs) {
        return { ...state, phase: "locked" };
      }
      return finish(state, event.at);

    case "browser-cancel":
    case "hidden":
      if (!live(state.phase)) return state;
      return { ...stopped(state, event.at), phase: "review", reviewReason: "interrupted" };

    case "tick":
      if (!recording(state.phase) || elapsedMs(state, event.at) < RECORDER.maxMs) return state;
      return { ...stopped(state, event.at), phase: "review", reviewReason: "limit" };

    case "pause":
      if (state.phase !== "locked") return state;
      return { ...stopped(state, event.at), phase: "paused" };

    case "resume":
      if (state.phase !== "paused") return state;
      return { ...state, phase: "locked", segmentStart: event.at };

    case "stop":
      if (state.phase !== "locked" && state.phase !== "paused") return state;
      return { ...stopped(state, event.at), phase: "review", reviewReason: "stopped" };

    case "send":
      if (state.phase !== "locked" && state.phase !== "paused" && state.phase !== "review") return state;
      return finish(state, event.at);

    case "delete":
      if (state.phase !== "locked" && state.phase !== "paused" && state.phase !== "review") return state;
      return { ...state, phase: "cancelled", segmentStart: null };
  }
}
