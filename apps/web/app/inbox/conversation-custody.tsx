"use client";

import { useCallback, useState } from "react";
import { getCustody, type CustodyEvent, readableError } from "@/lib/api";

/**
 * Who has held this conversation, and since when.
 *
 * ============================================================
 * WHY THIS SITS NEXT TO THE HANDOFF CHECKBOX
 * ============================================================
 *
 * That checkbox is the control whose history nobody could see. It shows one
 * boolean — the agent is paused, or it is not — and six different things in the
 * platform can set it: the agent escalating, a colleague replying, an employee
 * taking the conversation, somebody toggling it by hand, and the automatic
 * release that hands a stale handover back. Once it flipped off, the fact it
 * had ever been on was gone.
 *
 * On 2026-08-20 a customer had been waiting 28 hours, the box was unticked, and
 * the operators deck therefore said the agent should have answered and to check
 * the reply pipeline. The pipeline was fine. A colleague had answered on the
 * 10th and never come back. Working that out took message timestamps, the git
 * log and a guess; it is now the line directly under the box.
 *
 * ============================================================
 * LOADED ON DEMAND
 * ============================================================
 *
 * The inbox switches conversations constantly and this answers a question that
 * is asked rarely and deliberately. Fetching it on every click would make every
 * customer pay for the rare case.
 */
export function ConversationCustody({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<
    | { kind: "closed" }
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "loaded"; events: CustodyEvent[]; predatesRecording: boolean }
  >({ kind: "closed" });

  const open = useCallback(async () => {
    if (state.kind === "loading") return;
    if (state.kind === "loaded" || state.kind === "error") {
      setState({ kind: "closed" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const data = await getCustody(conversationId);
      setState({ kind: "loaded", events: data.events, predatesRecording: data.predatesRecording });
    } catch (err) {
      setState({
        kind: "error",
        message: readableError(err),
      });
    }
  }, [conversationId, state.kind]);

  return (
    <div className="ibx-custody">
      <button type="button" className="ibx-custody-toggle" onClick={() => void open()}>
        {state.kind === "loading" ? "Loading…" : "Who has had this?"}
      </button>

      {state.kind === "error" ? <p className="ibx-custody-note">{state.message}</p> : null}

      {state.kind === "loaded" ? (
        state.predatesRecording ? (
          /*
           * NOT RECORDED, WHICH IS NOT THE SAME AS NEVER HELD.
           *
           * Migration 062 backfills nothing on purpose: every handover before it
           * left no trace, and there is nothing honest to reconstruct one from.
           * Drawing an empty timeline here would let an absent record answer a
           * question it was never asked — which is the exact defect the table
           * was built to end, and it would be a poor joke to reintroduce it in
           * the thing that reads it.
           */
          <p className="ibx-custody-note">
            Nothing recorded for this conversation. It may never have changed hands, or it may have
            done so before the platform started keeping track — those are not distinguishable here,
            and guessing between them is what this record exists to stop.
          </p>
        ) : (
          <ol className="ibx-custody-list">
            {state.events.map((event, i) => (
              <li key={`${event.createdAt}-${i}`} className={event.held ? "held" : "released"}>
                <span className="ibx-custody-what">{describe(event)}</span>
                <span className="ibx-custody-when">{when(event.createdAt)}</span>
              </li>
            ))}
          </ol>
        )
      ) : null}
    </div>
  );
}

/**
 * Each reason in the words of somebody who has to act on it.
 *
 * The stored values are the platform's vocabulary — `stale_release`,
 * `agent_escalated` — and printing those raw would make the reader translate.
 * The actor is named where there is one; `stale_release` never has one, because
 * nobody did it.
 */
function describe(event: CustodyEvent): string {
  // THE ACTOR IS APPENDED, NOT INFIXED. Building "A colleague replied" + " by
  // X" produced "A colleague replied by atif@…", which is not a sentence. Seen
  // on screen; it reads fine in the source, which is exactly why it survived.
  const by = event.actor ? ` — ${event.actor}` : "";
  switch (event.reason) {
    case "agent_escalated":
      return "The agent handed this to a person and paused itself";
    case "human_replied":
      return `A colleague replied, which takes the conversation${by}`;
    case "taken_by_employee":
      return `Taken by a colleague${by}`;
    case "manual_toggle":
      return event.held ? `Handed to a person${by}` : `Given back to the agent${by}`;
    case "stale_release":
      // The only automatic one, and the only one worth explaining: a reader who
      // does not know this exists will think somebody untick​ed the box.
      return "Given back to the agent automatically — nobody was on the rota to take it";
    default:
      return event.held ? "Handed to a person" : "Given back to the agent";
  }
}

/** Age, not a timestamp — the same choice the operators deck makes, for the same reason. */
function when(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  // The boundary is a day, not two. At 48h a real history rendered "47h ago"
  // directly above "2d ago" for two events ONE HOUR APART, which reads as a
  // far bigger gap than it is. Past a day, days is the unit anybody thinks in.
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}
