"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  pushRecent,
  RECENT_KEY,
  searchEmoji,
  withTone,
  type EmojiData,
  type EmojiEntry,
} from "@/lib/team-chat/emoji-search";

/**
 * The emoji keyboard (2 Nov 2026): search, "Recently used" on this device, the
 * usual categories, and skin tones on a long press. The list (about 120 KB) is
 * fetched the first time any panel opens and kept for the rest of the visit,
 * so the chat itself never waits for it.
 */
let cache: Promise<EmojiData> | null = null;
function loadEmoji(): Promise<EmojiData> {
  cache ??= fetch("/emoji/en.json").then((response) => {
    if (!response.ok) throw new Error("emoji list unavailable");
    return response.json() as Promise<EmojiData>;
  });
  cache.catch(() => {
    cache = null;
  });
  return cache;
}

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === "string").slice(0, 24) : [];
  } catch {
    return [];
  }
}

function saveRecent(list: string[]) {
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // Private mode or storage blocked: recents just are not remembered.
  }
}

const TONE_LABELS = ["Default", "Light", "Medium-light", "Medium", "Medium-dark", "Dark"] as const;

export function EmojiPanel({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const [data, setData] = useState<EmojiData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const [tab, setTab] = useState<string>("recent");
  const [toneFor, setToneFor] = useState<EmojiEntry | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const panel = useRef<HTMLDivElement | null>(null);
  const search = useRef<HTMLInputElement | null>(null);

  // A computer types straight into the search; a phone would raise its
  // keyboard over the panel, so there the search waits for a tap.
  useEffect(() => {
    if (window.matchMedia("(pointer: fine)").matches) search.current?.focus();
  }, []);

  useEffect(() => {
    const list = readRecent();
    setRecent(list);
    if (list.length === 0) setTab("smileys");
    loadEmoji()
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (toneFor) setToneFor(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, toneFor]);

  const shown: string[] = useMemo(() => {
    if (!data) return [];
    if (query.trim()) return searchEmoji(data, query, 96);
    if (tab === "recent") return recent;
    return data.groups.find((g) => g.id === tab)?.emojis.map((e) => e.e) ?? [];
  }, [data, query, tab, recent]);

  const entryOf = useMemo(() => {
    const map = new Map<string, EmojiEntry>();
    for (const group of data?.groups ?? []) for (const entry of group.emojis) map.set(entry.e, entry);
    return map;
  }, [data]);

  function pick(emoji: string) {
    const next = pushRecent(recent, emoji);
    setRecent(next);
    saveRecent(next);
    setToneFor(null);
    onPick(emoji);
  }

  function startHold(entry: EmojiEntry | undefined) {
    held.current = false;
    if (!entry?.t) return;
    holdTimer.current = setTimeout(() => {
      held.current = true;
      setToneFor(entry);
    }, 450);
  }

  function endHold() {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }

  return (
    <div className="tc-emoji" ref={panel} role="dialog" aria-label="Emoji">
      <input
        className="tc-emoji-search"
        type="search"
        placeholder="Search emoji"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-label="Search emoji"
        ref={search}
      />
      {!query.trim() ? (
        <div className="tc-emoji-tabs" role="tablist" aria-label="Emoji categories">
          <button type="button" role="tab" aria-selected={tab === "recent"} title="Recently used" onClick={() => setTab("recent")}>
            🕘
          </button>
          {(data?.groups ?? []).map((group) => (
            <button
              key={group.id}
              type="button"
              role="tab"
              aria-selected={tab === group.id}
              title={group.label}
              onClick={() => setTab(group.id)}
            >
              {group.icon}
            </button>
          ))}
        </div>
      ) : null}
      <div className="tc-emoji-grid" role="listbox" aria-label="Emoji">
        {failed ? <p className="tc-emoji-note">The emoji list could not load. Your phone's own emoji keyboard still works.</p> : null}
        {data && shown.length === 0 ? (
          <p className="tc-emoji-note">{query.trim() ? "No emoji by that name." : "Emojis you use will show here."}</p>
        ) : null}
        {shown.map((emoji) => {
          const entry = entryOf.get(emoji);
          return (
            <button
              key={emoji}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={entry?.n ?? emoji}
              title={entry?.t ? `${entry.n} — hold for skin tones` : entry?.n}
              onPointerDown={() => startHold(entry)}
              onPointerUp={endHold}
              onPointerLeave={endHold}
              onContextMenu={(event) => {
                if (entry?.t) {
                  event.preventDefault();
                  setToneFor(entry);
                }
              }}
              onClick={() => {
                if (held.current) return;
                pick(emoji);
              }}
            >
              {emoji}
            </button>
          );
        })}
      </div>
      {toneFor ? (
        <div className="tc-emoji-tones" role="group" aria-label={`Skin tones for ${toneFor.n}`}>
          {([0, 1, 2, 3, 4, 5] as const).map((tone) => (
            <button key={tone} type="button" aria-label={TONE_LABELS[tone]} onClick={() => pick(withTone(toneFor.e, tone))}>
              {withTone(toneFor.e, tone)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
