"use client";

import { useEffect } from "react";
import { fontVariables } from "@/lib/fonts";
import "../deck/deck.css";
import "../deck/error.css";

/**
 * What the inbox shows when it cannot render.
 *
 * SEPARATE FROM THE DECK'S because the stakes and the advice differ. A deck
 * screen failing costs somebody a view of their own data; the inbox failing
 * costs them the ability to see that a customer is waiting, which is the one
 * thing on this platform with a clock attached.
 *
 * So this one names the thing that is actually at risk and points at the
 * screen that still answers it — the operators deck lists every customer
 * waiting and does not depend on any of this rendering.
 *
 * Everything else follows the deck boundary: no error.message in front of a
 * person, the digest offered so a report can be exact, and no guess at a cause
 * this boundary cannot know.
 */
export default function InboxError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Inbox failed to render", error);
  }, [error]);

  return (
    <div className={`deck-root err-root ${fontVariables}`}>
      <div className="err-card">
        <p className="err-eyebrow">Inbox</p>
        <h1 className="err-head">The inbox could not be drawn.</h1>
        <p className="err-body">
          Something failed while rendering this screen. No message has been sent, altered or lost —
          the failure is in showing you the conversations, not in the conversations themselves.
        </p>
        <p className="err-body">
          The agent is unaffected and is still answering customers. If you need to know who is
          waiting on a person right now, Needs attention lists them and does not depend on this
          screen.
        </p>

        <div className="err-actions">
          <button type="button" className="err-btn" onClick={reset}>
            Try the inbox again
          </button>
          <a className="err-btn ghost" href="/deck/operators">
            See who is waiting
          </a>
        </div>

        {error.digest ? (
          <p className="err-ref">
            If you report this, quote <code>{error.digest}</code> — it identifies this exact failure
            in the platform&rsquo;s own logs.
          </p>
        ) : null}
      </div>
    </div>
  );
}
