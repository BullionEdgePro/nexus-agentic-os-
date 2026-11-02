#!/usr/bin/env node
/**
 * Builds apps/web/public/emoji/en.json, the staff chat emoji keyboard's list
 * (2 Nov 2026). Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §3
 *
 *   node scripts/build-emoji-data.mjs
 *
 * From two official sources, downloaded into a fresh temporary folder and only
 * ever read as text:
 *   - Unicode's emoji-test.txt 15.0: every emoji, its group, its name, and
 *     which ones take skin tones;
 *   - CLDR's English annotations: the words people search with ("lol" finds
 *     😂, "love" finds ❤️).
 *
 * Emoji 15.0 and earlier only: those draw on iOS 16.4+, Android 14+ and
 * Windows 11, so nobody is sent a box. Skin-tone variants are not listed; an
 * emoji that takes them is marked `t: 1` and the keyboard builds the variant
 * (lib/team-chat/emoji-search.ts withTone), only where inserting the tone after
 * the first character gives exactly Unicode's own sequence.
 *
 * Re-run only to move to a newer Emoji version; the output is committed.
 */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EMOJI_TEST = "https://unicode.org/Public/emoji/15.0/emoji-test.txt";
const CLDR =
  "https://raw.githubusercontent.com/unicode-org/cldr-json/45.0.0/cldr-json/cldr-annotations-full/annotations/en/annotations.json";

const GROUPS = [
  { id: "smileys", label: "Smileys & people", icon: "😀", from: ["Smileys & Emotion", "People & Body"] },
  { id: "animals", label: "Animals & nature", icon: "🐻", from: ["Animals & Nature"] },
  { id: "food", label: "Food & drink", icon: "🍔", from: ["Food & Drink"] },
  { id: "travel", label: "Travel & places", icon: "🚗", from: ["Travel & Places"] },
  { id: "activities", label: "Activities", icon: "⚽", from: ["Activities"] },
  { id: "objects", label: "Objects", icon: "💡", from: ["Objects"] },
  { id: "symbols", label: "Symbols", icon: "🔣", from: ["Symbols"] },
  { id: "flags", label: "Flags", icon: "🏳️", from: ["Flags"] },
];

const TONES = ["\u{1F3FB}", "\u{1F3FC}", "\u{1F3FD}", "\u{1F3FE}", "\u{1F3FF}"];
const TONE_RE = /[\u{1F3FB}-\u{1F3FF}]/u;

/** The same rule as withTone in lib/team-chat/emoji-search.ts. */
function withTone(emoji, tone) {
  const chars = [...emoji];
  const rest = chars.slice(1);
  if (rest[0] === "️") rest.shift();
  return chars[0] + tone + rest.join("");
}

async function download(url, folder, name) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const path = join(folder, name);
  writeFileSync(path, await response.text(), "utf8");
  return readFileSync(path, "utf8");
}

const folder = mkdtempSync(join(tmpdir(), "nexus-emoji-"));
try {
  const testFile = await download(EMOJI_TEST, folder, "emoji-test.txt");
  const annotations = JSON.parse(await download(CLDR, folder, "annotations.json")).annotations.annotations;

  const byGroup = new Map();
  const bases = new Map(); // base with FE0F removed → the listed entry
  const toned = [];
  let group = "";
  for (const line of testFile.split("\n")) {
    const heading = /^# group: (.+)$/.exec(line.trim());
    if (heading) {
      group = heading[1];
      continue;
    }
    const m = /^[0-9A-F ]+;\s*fully-qualified\s*#\s*(\S+)\s+E(\d+)\.(\d+)\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const [, emoji, major, minor, name] = m;
    if (Number(major) > 15 || (Number(major) === 15 && Number(minor) > 0)) continue;
    if (group === "Component") continue;
    if (TONE_RE.test(emoji)) {
      toned.push(emoji);
      continue;
    }
    const words = (annotations[emoji]?.default ?? annotations[emoji.replace(/️/g, "")]?.default ?? [])
      .map((w) => w.toLowerCase())
      .filter((w) => !name.toLowerCase().split(/\s+/).includes(w))
      .slice(0, 6);
    const entry = { e: emoji, n: name.toLowerCase(), ...(words.length ? { k: words } : {}) };
    if (!byGroup.has(group)) byGroup.set(group, []);
    byGroup.get(group).push(entry);
    bases.set(emoji.replace(/️/g, ""), entry);
  }

  // A base takes tones only when every one of Unicode's five single-tone
  // variants is exactly withTone(base, tone).
  for (const variant of toned) {
    const tones = [...variant].filter((c) => TONE_RE.test(c));
    if (tones.length !== 1) continue;
    const entry = bases.get(variant.replace(TONE_RE, "").replace(/️/g, ""));
    if (entry && withTone(entry.e, tones[0]) === variant) entry.tones = (entry.tones ?? 0) + 1;
  }
  for (const entry of bases.values()) {
    if (entry.tones === TONES.length) entry.t = 1;
    delete entry.tones;
  }

  const groups = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    icon: g.icon,
    emojis: g.from.flatMap((name) => byGroup.get(name) ?? []),
  }));
  const out = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "public", "emoji", "en.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ version: "15.0", groups }) + "\n", "utf8");
  const count = groups.reduce((sum, g) => sum + g.emojis.length, 0);
  const tonable = groups.reduce((sum, g) => sum + g.emojis.filter((x) => x.t).length, 0);
  console.log(`wrote ${out}: ${count} emojis, ${tonable} take skin tones`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
