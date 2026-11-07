"use client";

import { useEffect, useState } from "react";

/**
 * The private listing page's two calls (7 Nov 2026). The view is counted by
 * this script once a person has the page open — WhatsApp's link preview fetches
 * the page as the agent sends it and runs no script, so it is never a "view".
 * "I'm interested" tells the agent once; pressing again changes nothing.
 * Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §5, §6
 */

export function ViewBeacon({ token, apiUrl }: { token: string; apiUrl: string }) {
  useEffect(() => {
    void fetch(`${apiUrl}/pocket-shares/${token}/view`, { method: "POST", keepalive: true }).catch(() => undefined);
  }, [token, apiUrl]);
  return null;
}

export function InterestButton({ token, apiUrl, agentFirstName }: { token: string; apiUrl: string; agentFirstName: string }) {
  const [state, setState] = useState<"idle" | "sending" | "done" | "failed">("idle");
  if (state === "done") {
    return (
      <p className="pocket-thanks" role="status">
        {`Thank you — ${agentFirstName} will be in touch.`}
      </p>
    );
  }
  return (
    <>
      <button
        type="button"
        className="pocket-button"
        disabled={state === "sending"}
        onClick={() => {
          setState("sending");
          fetch(`${apiUrl}/pocket-shares/${token}/interest`, { method: "POST" })
            .then((res) => setState(res.ok ? "done" : "failed"))
            .catch(() => setState("failed"));
        }}
      >
        I&apos;m interested
      </button>
      {state === "failed" ? (
        <p className="pocket-note" role="status">
          That did not go through — please message {agentFirstName} directly.
        </p>
      ) : null}
    </>
  );
}
