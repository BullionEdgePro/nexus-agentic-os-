/**
 * The emoji keyboard's search, skin tones and "recently used" (2 Nov 2026).
 * The list is public/emoji/en.json, built by scripts/build-emoji-data.mjs from
 * Unicode's data and fetched the first time the panel opens. Pure.
 */

export interface EmojiEntry {
  /** The emoji. */
  e: string;
  /** Unicode's name, lower case: "thumbs up". */
  n: string;
  /** More words people search with: "like", "yes". */
  k?: string[];
  /** 1 when it takes skin tones (see withTone). */
  t?: 1;
}

export interface EmojiGroup {
  id: string;
  label: string;
  icon: string;
  emojis: EmojiEntry[];
}

export interface EmojiData {
  version: string;
  groups: EmojiGroup[];
}

/** Emojis whose name or search words start with the query, names first. */
export function searchEmoji(data: EmojiData, query: string, limit = 48): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const byName: string[] = [];
  const byWord: string[] = [];
  for (const group of data.groups) {
    for (const entry of group.emojis) {
      if (entry.n.startsWith(q) || entry.n.split(/[\s:,-]+/).some((word) => word.startsWith(q))) byName.push(entry.e);
      else if (entry.k?.some((word) => word.startsWith(q))) byWord.push(entry.e);
    }
  }
  return [...new Set([...byName, ...byWord])].slice(0, limit);
}

const TONES = ["", "\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"] as const;

/** The emoji with skin tone 1–5 (light to dark); 0 leaves it as it is. */
export function withTone(emoji: string, tone: 0 | 1 | 2 | 3 | 4 | 5): string {
  if (tone === 0) return emoji;
  const chars = [...emoji];
  const rest = chars.slice(1);
  // ☝️ is "☝ + FE0F"; its toned form drops the FE0F: ☝🏻.
  if (rest[0] === "️") rest.shift();
  return chars[0] + TONES[tone] + rest.join("");
}

export const RECENT_KEY = "nexus-emoji-recent";

/** The recent row after using `emoji`: it moves to the front, the row stays short. */
export function pushRecent(list: string[], emoji: string, max = 24): string[] {
  return [emoji, ...list.filter((e) => e !== emoji)].slice(0, max);
}
