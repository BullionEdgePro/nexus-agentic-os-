import { StatusCard } from "../../kit/status-card";
import type { Tone } from "@/lib/kit/wait-band";

/**
 * A customer's conversations as small cards in their state's colour (2 Nov
 * 2026, Cream pages 2a): open green, waiting on them mustard, finished ink —
 * each one a link to the chat itself.
 */
export const STATE_TONE = { open: "forest", pending: "mustard", resolved: "ink", closed: "ink" } as const;

export function HistoryCards({
  conversations,
}: {
  conversations: Array<{ id: string; status: string; lastMessageAt: string | null; messages?: number }>;
}) {
  if (conversations.length === 0) return <p className="cu-note">None with this business.</p>;
  return (
    <div className="kit-cards cu-history">
      {conversations.map((c) => {
        // A state this screen does not know is drawn plain, never guessed at.
        const tone: Tone = STATE_TONE[c.status as keyof typeof STATE_TONE] ?? "paper";
        const count = c.messages === undefined ? null : `${c.messages} ${c.messages === 1 ? "message" : "messages"}`;
        const last = ago(c.lastMessageAt);
        const foot = last === "never" ? "no messages yet" : `last message ${last}`;
        const state = c.status.charAt(0).toUpperCase() + c.status.slice(1);
        return (
          <StatusCard
            key={c.id}
            tone={tone}
            title={state}
            subtitle={count ?? undefined}
            footer={foot}
            href={`/inbox?conversation=${encodeURIComponent(c.id)}`}
            label={`${state} conversation${count ? `, ${count}` : ""}, ${foot}. Open the chat.`}
          />
        );
      })}
    </div>
  );
}

/** Age, not a timestamp: "3d ago" is what a reader acts on. */
export function ago(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
