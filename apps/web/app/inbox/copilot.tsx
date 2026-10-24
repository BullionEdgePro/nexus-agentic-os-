"use client";

import { useState } from "react";
import { readableError, suggestReply, type DraftStyle } from "@/lib/api";
import { SummaryBlock } from "./details-panel";

/**
 * Copilot (24 Oct 2026, Focus workspace): beside the chat, what the customer
 * wants and a reply drafted from the thread.
 *
 * TWO PROMISES. Nothing runs without a tap — each of these is a model call.
 * And nothing is ever sent from here: a draft lands in the reply box, where
 * the person reads it and sends it, or does not. The drafting rules are the
 * server's (no invented facts, prices, dates or promises), whatever the style.
 */
const STYLES: { style: DraftStyle | null; label: string }[] = [
  { style: null, label: "Draft a reply" },
  { style: "shorter", label: "Shorter" },
  { style: "friendlier", label: "Friendlier" },
  { style: "arabic", label: "Arabic" },
];

export function Copilot({ conversationId, onDraft }: { conversationId: string; onDraft: (text: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function draft(style: DraftStyle | null, label: string) {
    if (busy) return;
    setBusy(label);
    setError(null);
    try {
      const { suggestion } = await suggestReply(conversationId, style ?? undefined);
      onDraft(suggestion);
      setDone(label);
    } catch (err) {
      setError(readableError(err, "Copilot could not draft that. Write the reply yourself."));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="ibx-copilot" aria-label="Copilot">
      <header className="ibx-copilot-head">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.8 4.6L18 9.4l-4.2 1.8L12 16l-1.8-4.8L6 9.4l4.2-1.8L12 3Z" />
          <path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2Z" />
        </svg>
        <b>Copilot</b>
        <span>reads this chat only</span>
      </header>
      <SummaryBlock conversationId={conversationId} />
      <div className="ibx-copilot-draft">
        <h4 className="dp-h">Reply</h4>
        <div className="ibx-copilot-row">
          {STYLES.map(({ style, label }, i) => (
            <button
              key={label}
              type="button"
              className={i === 0 ? "primary" : undefined}
              disabled={!!busy}
              onClick={() => void draft(style, label)}
            >
              {busy === label ? "Drafting…" : label}
            </button>
          ))}
        </div>
        {done && !busy ? <p className="ibx-copilot-done">In the reply box. Read it, then send it yourself.</p> : null}
        {error ? <p className="ibx-copilot-error">{error}</p> : null}
      </div>
    </section>
  );
}
