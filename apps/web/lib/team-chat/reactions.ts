import type { TeamReaction } from "../api";

/**
 * What a tap on an emoji does to a message's reactions (2 Nov 2026): one
 * reaction per person, as in WhatsApp. The same emoji again takes mine off;
 * another one replaces it. Pure, so the screen can show the change at once and
 * put it back if the server refuses.
 */
export function toggleReaction(
  reactions: TeamReaction[],
  emoji: string,
  me: { key: string; name: string }
): TeamReaction[] {
  const had = mineOf(reactions, me.key);
  const without = reactions
    .map((group) => ({ ...group, by: group.by.filter((person) => person.key !== me.key) }))
    .filter((group) => group.by.length > 0);
  if (had === emoji) return without;
  const existing = without.find((group) => group.emoji === emoji);
  if (existing) return without.map((group) => (group === existing ? { ...group, by: [...group.by, me] } : group));
  return [...without, { emoji, by: [me] }];
}

/** The emoji I reacted with, or null. */
export function mineOf(reactions: TeamReaction[], key: string): string | null {
  return reactions.find((group) => group.by.some((person) => person.key === key))?.emoji ?? null;
}
