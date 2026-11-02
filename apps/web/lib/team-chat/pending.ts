/**
 * The sends still on their way, shown in the chat they were made in (2 Nov
 * 2026, final review). The hook keeps every chat's pending sends in one list
 * and never drops them when another chat opens — an upload made in the room
 * and still going when you open a direct chat must still be there, sending or
 * "Not sent · Retry", when you come back. Each chat shows only its own. Pure.
 */
export function pendingFor<P extends { threadId: string }>(list: P[], threadId: string | null): P[] {
  return threadId ? list.filter((p) => p.threadId === threadId) : [];
}
