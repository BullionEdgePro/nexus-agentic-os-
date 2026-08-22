"use client";

import { useEffect } from "react";
import { fontVariables } from "@/lib/fonts";
import "./deck.css";
import "./error.css";

/**
 * What a deck screen shows when it cannot render.
 *
 * ============================================================
 * WHY THIS FILE DID NOT EXIST, AND WHAT THAT COST
 * ============================================================
 *
 * There was no error boundary anywhere in this app — no error.tsx, no
 * global-error.tsx, no not-found.tsx. A render error therefore produced a
 * completely blank white page: no message, no heading, no navigation, nothing
 * to click. Found by driving the screens: four of them went white and the only
 * evidence anything had happened was a stack trace in a console the person
 * reading the page is not looking at.
 *
 * A blank page is the worst failure this console can present, because it is
 * indistinguishable from every other blank page. "The platform is down", "my
 * connection dropped", "I mistyped the URL" and "one component threw" all look
 * identical, and only one of them is worth telephoning anybody about. This
 * whole codebase is an argument against silences that cannot be told apart;
 * the screens themselves were the one place it had not been made.
 *
 * ============================================================
 * WHAT IT SAYS, AND WHAT IT REFUSES TO SAY
 * ============================================================
 *
 * It does not show `error.message`. That string is written for whoever wrote
 * the code — it names components and properties — and pasting it in front of a
 * person is the same mistake as showing them "Failed to fetch", which took a
 * whole pass to undo. What it does show is the DIGEST: a short server-assigned
 * id that means nothing on its own and everything in a log search, so somebody
 * reporting this has something exact to quote.
 *
 * It also does not claim to know the cause. This boundary catches a component
 * that threw, and that is all it can honestly say. Guessing at "the platform is
 * having problems" would be inventing a diagnosis from an absence — the same
 * defect this deck's operators exist to stop.
 *
 * THE REST OF THE CONSOLE SURVIVES. This is a route-segment boundary, so the
 * shell and the navigation rail around it stay mounted: whoever hits this can
 * still reach every other screen, which is most of what they want in the
 * moment. That is the reason it sits here and not only at the root.
 */
export default function DeckError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The one place the developer-facing detail belongs. Without this the
    // digest above is unmatchable to anything on the client side.
    console.error("Deck screen failed to render", error);
  }, [error]);

  return (
    <div className={`deck-root err-root ${fontVariables}`}>
      <div className="err-card">
        <p className="err-eyebrow">This screen</p>
        <h1 className="err-head">This screen could not be drawn.</h1>
        <p className="err-body">
          Something in it failed while rendering. Nothing has been changed or lost — the failure is
          in showing you this page, not in the data behind it.
        </p>
        <p className="err-body">
          The rest of the console still works: every other screen is reachable from the rail on the
          left.
        </p>

        <div className="err-actions">
          {/* `reset` re-renders the segment. Worth offering first: a render
              error caused by a transient state often does not recur, and a
              person who has to reload the whole console loses whatever else
              they had open. */}
          <button type="button" className="err-btn" onClick={reset}>
            Try this screen again
          </button>
          <a className="err-btn ghost" href="/deck/operators">
            Go to Needs attention
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
