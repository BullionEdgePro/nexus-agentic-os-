/**
 * WhatsApp groups a run of messages from one person: the name and the
 * bubble's tail show on the first only (2 Nov 2026). A run ends when someone
 * else writes or five minutes pass. Pure.
 */
export function groupRuns(
  messages: Array<{ authorEmployeeId: string | null; authorIsAdmin: boolean; createdAt: string; deletedAt: string | null }>,
  gapMs = 5 * 60_000
): boolean[] {
  const author = (m: (typeof messages)[number]) => (m.authorIsAdmin ? "admin" : (m.authorEmployeeId ?? "unknown"));
  return messages.map((m, i) => {
    if (i === 0) return true;
    const previous = messages[i - 1]!;
    if (author(previous) !== author(m)) return true;
    return Date.parse(m.createdAt) - Date.parse(previous.createdAt) > gapMs;
  });
}
