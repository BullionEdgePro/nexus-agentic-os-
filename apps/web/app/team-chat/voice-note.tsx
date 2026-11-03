"use client";

import { useEffect, useRef, useState } from "react";
import { teamFileUrl, type TeamChatFile } from "@/lib/api";
import { formatClock, seekTime } from "@/lib/team-chat/waveform";
import { downloadFile } from "./download";

/**
 * A voice note in the thread (2 Nov 2026): ▶, the real waveform, the time and a
 * speed chip, as in WhatsApp. Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §2
 *
 *   - fetched once, with the session cookie, into an object URL — so playing
 *     needs nothing special from the server, and a replay is instant;
 *   - one note plays at a time; when one ends, the next voice note in the
 *     thread plays on, as WhatsApp does with a run of notes;
 *   - a dot marks notes not yet played on this device;
 *   - a device that cannot play the note's type gets ⬇ Download instead of a
 *     player that silently does nothing.
 */

const PLAYED_KEY = "nexus-voice-played";
const RATES = [1, 1.5, 2] as const;
const blobs = new Map<string, Promise<string>>();

/** The note playing now, so starting another pauses it. */
let nowPlaying: { id: string; pause: () => void } | null = null;

function playedSet(): Set<string> {
  try {
    const raw = window.localStorage.getItem(PLAYED_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function markPlayed(id: string) {
  try {
    const set = playedSet();
    set.add(id);
    window.localStorage.setItem(PLAYED_KEY, JSON.stringify([...set].slice(-500)));
  } catch {
    // Without storage every note simply counts as played.
  }
}

function sourceOf(threadId: string, file: TeamChatFile): Promise<string> {
  let found = blobs.get(file.id);
  if (!found) {
    found = fetch(teamFileUrl(threadId, file.id), { credentials: "include" }).then(async (response) => {
      if (!response.ok) throw new Error(`API ${response.status} on the voice note`);
      return URL.createObjectURL(await response.blob());
    });
    found.catch(() => blobs.delete(file.id));
    blobs.set(file.id, found);
  }
  return found;
}

export function VoiceNote({ file, threadId, mine }: { file: TeamChatFile; threadId: string; mine: boolean }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState(0);
  const [rate, setRate] = useState<(typeof RATES)[number]>(1);
  const [played, setPlayed] = useState(true);
  const [playable, setPlayable] = useState(true);
  const duration = (file.durationMs ?? 0) / 1000;

  useEffect(() => {
    setPlayed(mine || playedSet().has(file.id));
    const probe = document.createElement("audio");
    setPlayable(probe.canPlayType(file.mime) !== "" || probe.canPlayType(file.mime.split(";")[0]!) !== "");
  }, [file.id, file.mime, mine]);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    // The previous note in the thread finished: this one plays on.
    const onCue = () => void start(true);
    el.addEventListener("tc-play", onCue);
    return () => el.removeEventListener("tc-play", onCue);
  });

  useEffect(
    () => () => {
      if (nowPlaying?.id === file.id) nowPlaying = null;
      audio.current?.pause();
    },
    [file.id]
  );

  /** Play; `auto` when the previous note ended, not a tap. */
  async function start(auto = false) {
    if (failed) setFailed(false);
    if (!audio.current) {
      setLoading(true);
      try {
        const url = await sourceOf(threadId, file);
        const el = new Audio(url);
        el.preload = "auto";
        el.addEventListener("timeupdate", () => setPosition(el.currentTime));
        el.addEventListener("pause", () => setPlaying(false));
        el.addEventListener("play", () => setPlaying(true));
        el.addEventListener("ended", () => {
          setPlaying(false);
          setPosition(0);
          if (nowPlaying?.id === file.id) nowPlaying = null;
          playNext();
        });
        audio.current = el;
      } catch {
        setFailed(true);
        return;
      } finally {
        setLoading(false);
      }
    }
    const el = audio.current;
    if (nowPlaying && nowPlaying.id !== file.id) nowPlaying.pause();
    nowPlaying = { id: file.id, pause: () => el.pause() };
    el.playbackRate = rate;
    try {
      await el.play();
      if (!played) {
        markPlayed(file.id);
        setPlayed(true);
      }
    } catch (err) {
      // An iPhone will not start a note nobody tapped: it simply waits for ▶.
      if (auto && err instanceof DOMException && err.name === "NotAllowedError") return;
      setFailed(true);
    }
  }

  function playNext() {
    const all = [...document.querySelectorAll<HTMLElement>("[data-voice-note]")];
    const here = root.current ? all.indexOf(root.current) : -1;
    const next = here >= 0 ? all[here + 1] : undefined;
    next?.dispatchEvent(new Event("tc-play"));
  }

  function toggle() {
    if (playing) audio.current?.pause();
    else void start();
  }

  function seek(event: React.PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const el = audio.current;
    if (el) {
      el.currentTime = seekTime(fraction, el.duration, file.durationMs ?? 0);
      setPosition(el.currentTime);
    } else {
      void start().then(() => {
        if (audio.current) audio.current.currentTime = seekTime(fraction, audio.current.duration, file.durationMs ?? 0);
      });
    }
  }

  function nextRate() {
    const following = RATES[(RATES.indexOf(rate) + 1) % RATES.length]!;
    setRate(following);
    if (audio.current) audio.current.playbackRate = following;
  }

  if (!playable) {
    return (
      <div className="tc-voice" data-voice-note ref={root}>
        <button type="button" className="tc-voice-play" aria-label="Download voice note" onClick={() => void downloadFile(threadId, file).catch(() => setFailed(true))}>
          ⬇
        </button>
        <span className="tc-voice-note-text">
          This phone can't play this voice note — download it ({formatClock(file.durationMs ?? 0)})
        </span>
      </div>
    );
  }

  const bars = file.waveform && file.waveform.length ? file.waveform : new Array(48).fill(30);
  const progress = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <div className={`tc-voice${playing ? " playing" : ""}`} data-voice-note ref={root}>
      <button
        type="button"
        className="tc-voice-play"
        aria-label={playing ? "Pause voice note" : "Play voice note"}
        onClick={toggle}
        disabled={loading}
      >
        {loading ? "…" : playing ? "⏸" : "▶"}
      </button>
      <div className="tc-voice-body">
        <div
          className="tc-wave"
          role="slider"
          aria-label="Position in voice note"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(position)}
          tabIndex={0}
          onPointerDown={seek}
          onKeyDown={(event) => {
            const el = audio.current;
            if (!el) return;
            if (event.key === "ArrowRight") el.currentTime = Math.min(el.duration || duration, el.currentTime + 5);
            if (event.key === "ArrowLeft") el.currentTime = Math.max(0, el.currentTime - 5);
          }}
        >
          {bars.map((height, index) => (
            <i
              key={index}
              className={index / bars.length < progress ? "on" : undefined}
              style={{ height: `${Math.max(12, height)}%` }}
            />
          ))}
        </div>
        <span className="tc-voice-meta">
          {!played ? <b className="tc-voice-new" aria-label="Not played yet" /> : null}
          {formatClock((playing || position > 0 ? position : duration) * 1000)}
          {failed ? <span className="tc-voice-fail"> · could not play — tap ▶ to retry</span> : null}
        </span>
      </div>
      <button type="button" className="tc-voice-rate" aria-label={`Speed ${rate}×`} onClick={nextRate}>
        {rate}×
      </button>
    </div>
  );
}
