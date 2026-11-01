/**
 * The sound kit (spec 2026-11-01-cream-foundation-design.md §4).
 *
 * Sound is a nicety; a nicety must never break the page. So: silent when the
 * person muted it, silent where the browser has no Web Audio, silent when
 * storage is blocked — and never an exception in any of those. One shared
 * AudioContext, because browsers cap how many a page may open.
 *
 * The tests share the module's one context, so they run in order: first with
 * no Web Audio at all, then with a stand-in that counts what is built.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { play, isMuted, setMuted, installSoundBridge, SOUND_KEY } from "@/lib/sound";

function memoryStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    store,
  };
}

/** A stand-in AudioContext: counts contexts built and voices started. */
const audio = { contexts: 0, voices: 0 };
const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} });
const node = () => ({
  connect() {},
  start() {
    audio.voices++;
  },
  stop() {},
  frequency: param(),
  gain: param(),
  Q: param(),
  type: "",
  buffer: null,
});
class StubAudioContext {
  constructor() {
    audio.contexts++;
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.state = "running";
    this.destination = {};
  }
  createOscillator() { return node(); }
  createGain() { return node(); }
  createBiquadFilter() { return node(); }
  createBufferSource() { return node(); }
  createBuffer(_channels, length) { return { getChannelData: () => new Float32Array(length) }; }
  resume() { return Promise.resolve(); }
}

beforeEach(() => {
  globalThis.localStorage = memoryStorage();
});

test("the key is the one the spec names", () => {
  assert.equal(SOUND_KEY, "nexus-sound");
});

test("a browser without Web Audio stays silent and does not throw", () => {
  delete globalThis.AudioContext;
  delete globalThis.webkitAudioContext;
  assert.doesNotThrow(() => play("chime"));
  globalThis.AudioContext = StubAudioContext;
});

test("muted means no sound is even prepared", () => {
  globalThis.localStorage = memoryStorage({ [SOUND_KEY]: "off" });
  play("chime");
  play("ping");
  assert.equal(audio.contexts, 0);
  assert.equal(audio.voices, 0);
});

test("unmuted, every sound plays from one shared AudioContext", () => {
  for (const name of ["whoosh", "pop", "tick", "chime", "ping"]) play(name);
  play("pop", { close: true });
  assert.equal(audio.contexts, 1);
  assert.ok(audio.voices >= 6, `only ${audio.voices} voices started`);
});

test("storage that throws reads as sound on, and muting does not throw", () => {
  globalThis.localStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.equal(isMuted(), false);
  assert.doesNotThrow(() => setMuted(true));
});

test("muting is remembered", () => {
  setMuted(true);
  assert.equal(globalThis.localStorage.store[SOUND_KEY], "off");
  assert.equal(isMuted(), true);
  setMuted(false);
  assert.equal(isMuted(), false);
});

test("any screen can ask for a sound by event, until the bridge is removed", () => {
  const target = new EventTarget();
  const remove = installSoundBridge(target);
  const before = audio.voices;
  target.dispatchEvent(new CustomEvent("nexus:sound", { detail: "tick" }));
  const afterOne = audio.voices;
  assert.ok(afterOne > before, "the bridge played the sound");
  remove();
  target.dispatchEvent(new CustomEvent("nexus:sound", { detail: "tick" }));
  assert.equal(audio.voices, afterOne, "a removed bridge plays nothing");
});

test("a sound name nobody knows is ignored, not thrown", () => {
  const before = audio.voices;
  assert.doesNotThrow(() => play("trumpet"));
  assert.equal(audio.voices, before);
});

test("the mute switch first renders as sound on, as a labelled switch", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { SoundToggle } = await import("@/app/sound-toggle");
  const html = renderToStaticMarkup(createElement(SoundToggle));
  assert.match(html, /role="switch"/);
  assert.match(html, /aria-checked="true"/);
  assert.match(html, /aria-label="Sound on — mute"/);
  assert.match(html, /class="nx-sound"/);
});
