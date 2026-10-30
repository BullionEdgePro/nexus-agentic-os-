/**
 * How a client stands with WhatsApp, for the Clients tab's filters (30 Oct 2026).
 *
 * "free" is the one that changes what can be sent: a client who wrote to this
 * person's number in the last 23h50m can get any text right now (the server
 * reads the same margin), everybody else only an approved message.
 */
export type ClientFilter = "all" | "free" | "week" | "quiet" | "never";
export type ClientStanding = "free" | "week" | "month" | "quiet" | "never";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function standingOf(lastInboundAt: string | null | undefined, now = Date.now()): ClientStanding {
  if (!lastInboundAt) return "never";
  const age = now - new Date(lastInboundAt).getTime();
  if (age < 23 * HOUR + 50 * MINUTE) return "free";
  if (age < 7 * DAY) return "week";
  if (age < 30 * DAY) return "month";
  return "quiet";
}

export function matchesFilter(filter: ClientFilter, lastInboundAt: string | null | undefined, now = Date.now()): boolean {
  if (filter === "all") return true;
  const standing = standingOf(lastInboundAt, now);
  // "Wrote this week" includes the people who wrote today.
  if (filter === "week") return standing === "free" || standing === "week";
  return standing === filter;
}

/** "3h ago", "2 days ago", "14 Oct" — how long since they last wrote. */
export function sinceWrote(lastInboundAt: string | null | undefined, now = Date.now()): string {
  if (!lastInboundAt) return "never wrote to you";
  const then = new Date(lastInboundAt);
  const minutes = Math.max(0, Math.round((now - then.getTime()) / MINUTE));
  if (minutes < 60) return `wrote ${minutes || 1}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `wrote ${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `wrote ${days} day${days === 1 ? "" : "s"} ago`;
  return `last wrote ${then.toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/** Two letters for the avatar. */
export function initialsOf(name: string | null | undefined, waId: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return waId.slice(-2);
  return (words[0][0] + (words[1]?.[0] ?? "")).toUpperCase();
}
