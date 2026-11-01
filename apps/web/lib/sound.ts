/**
 * Nexus's sounds (spec 2026-11-01-cream-foundation-design.md §4).
 *
 * Five small sounds at the moments that matter — a page changing, a window
 * opening, a switch, something sent, a new message — synthesised here with the
 * Web Audio API, so there are no audio files to download and nothing to cache.
 *
 * On by default, quiet, and remembered per browser when muted. A nicety must
 * never break the page: with no Web Audio, blocked storage or a suspended
 * context, `play` does nothing and throws nothing. Browsers refuse sound until
 * the first click or key press, so a page's first load is silent by design.
 *
 * Screens that would rather not import this can ask by event:
 *   window.dispatchEvent(new CustomEvent("nexus:sound", { detail: "chime" }))
 */
export type SoundName = "whoosh" | "pop" | "tick" | "chime" | "ping";

export const SOUND_KEY = "nexus-sound";

const VOLUME = 0.22;
const NAMES: readonly SoundName[] = ["whoosh", "pop", "tick", "chime", "ping"];

type Ctor = new () => AudioContext;

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

/** The choice made on this page, which outlives storage that refuses it. */
let chosen: boolean | null = null;

export function isMuted(): boolean {
  if (chosen !== null) return chosen;
  try {
    return globalThis.localStorage?.getItem(SOUND_KEY) === "off";
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  chosen = muted;
  try {
    globalThis.localStorage?.setItem(SOUND_KEY, muted ? "off" : "on");
  } catch {
    // Private mode or blocked storage: the choice lasts for this page only.
  }
}

/** The one shared context, built on first use; null where there is none. */
function context(): AudioContext | null {
  if (ctx) return ctx;
  const g = globalThis as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  const Make = g.AudioContext ?? g.webkitAudioContext;
  if (!Make) return null;
  ctx = new Make();
  master = ctx.createGain();
  master.gain.value = VOLUME;
  master.connect(ctx.destination);
  return ctx;
}

/** A tone from `from` to `to` Hz over `ms`, fading out by `decay` ms. */
function tone(ac: AudioContext, at: number, type: OscillatorType, from: number, to: number, ms: number, decay: number, peak = 1) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, at);
  if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, at + ms / 1000);
  gain.gain.setValueAtTime(peak, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + decay / 1000);
  osc.connect(gain);
  gain.connect(master!);
  osc.start(at);
  osc.stop(at + decay / 1000 + 0.02);
}

/** Filtered noise swept upward — the page sliding past. */
function whoosh(ac: AudioContext, at: number) {
  const length = Math.floor(ac.sampleRate * 0.18);
  const buffer = ac.createBuffer(1, length, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  const source = ac.createBufferSource();
  source.buffer = buffer;
  const band = ac.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.8;
  band.frequency.setValueAtTime(400, at);
  band.frequency.exponentialRampToValueAtTime(2400, at + 0.18);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.linearRampToValueAtTime(0.5, at + 0.06);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
  source.connect(band);
  band.connect(gain);
  gain.connect(master!);
  source.start(at);
  source.stop(at + 0.2);
}

export function play(name: SoundName, opts?: { close?: boolean }): void {
  if (!NAMES.includes(name) || isMuted()) return;
  try {
    const ac = context();
    if (!ac) return;
    if (ac.state === "suspended") void ac.resume();
    const at = ac.currentTime;
    switch (name) {
      case "whoosh":
        whoosh(ac, at);
        break;
      case "pop":
        if (opts?.close) tone(ac, at, "sine", 880, 520, 70, 110, 0.7);
        else tone(ac, at, "sine", 520, 880, 70, 110, 0.7);
        break;
      case "tick":
        tone(ac, at, "square", 1800, 1800, 30, 30, 0.15);
        break;
      case "chime":
        tone(ac, at, "sine", 660, 660, 250, 250, 0.6);
        tone(ac, at + 0.12, "sine", 990, 990, 250, 250, 0.6);
        break;
      case "ping":
        tone(ac, at, "sine", 1320, 1320, 300, 300, 0.6);
        break;
    }
  } catch {
    // A sound that could not play is not worth an error on the page.
  }
}

/** Plays whatever `nexus:sound` events ask for; returns the remover. */
export function installSoundBridge(target: EventTarget = globalThis as unknown as EventTarget): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent).detail;
    if (typeof detail === "string") play(detail as SoundName);
  };
  target.addEventListener("nexus:sound", listener);
  return () => target.removeEventListener("nexus:sound", listener);
}
