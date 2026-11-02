import type { StaffWorkAttention } from "@/lib/api";
import { formatWait, waitTone } from "@/lib/kit/wait-band";
import { Initials, StatusCard } from "../kit";

/**
 * The customers waiting longest, across every business (2 Nov 2026, Cream
 * pages 2a): the front page's version of the video's "hot deals". Each card is
 * coloured by how long they have waited — forest under half an hour, mustard to
 * two hours, terracotta to a day, ink beyond — and opens the chat.
 *
 * Presentational and pure, so it renders the same in a test as on the page;
 * the page fetches and passes the moment it fetched as `now`.
 */
export function WaitingCards({
  waiting,
  total,
  now,
}: {
  waiting: StaffWorkAttention["oldestWaiting"];
  total: number;
  now: number;
}) {
  if (waiting.length === 0) {
    return (
      <div className="kit-cards">
        <StatusCard tone="paper" title="Nobody is waiting." subtitle="Every customer has had a reply." />
      </div>
    );
  }
  return (
    <>
      <div className="kit-cards">
        {waiting.map((w) => {
          const waited = Math.max(0, now - Date.parse(w.since));
          const who = w.contactName ?? "A customer";
          // A chat nobody owns is still a customer waiting — said, not hidden.
          const owner = w.employeeName ? ` for ${w.employeeName}` : ", and nobody has the chat yet";
          return (
            <StatusCard
              key={w.conversationId}
              tone={waitTone(waited)}
              title={who}
              subtitle={w.businessName}
              figure={formatWait(waited)}
              footer={
                w.employeeName ? (
                  <>
                    <Initials name={w.employeeName} />
                    <span dir="auto">{w.employeeName}</span>
                  </>
                ) : (
                  <span>nobody yet</span>
                )
              }
              href={`/inbox?conversation=${w.conversationId}`}
              label={`${who} at ${w.businessName}, waiting ${formatWait(waited)}${owner}. Open the chat.`}
            />
          );
        })}
      </div>
      {total > waiting.length ? (
        <a className="kit-more" href="/deck/activity">
          +{total - waiting.length} more waiting
        </a>
      ) : null}
    </>
  );
}
