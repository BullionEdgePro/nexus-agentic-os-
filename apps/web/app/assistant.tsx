"use client";

import { useEffect, useRef, useState } from "react";
import { askAssistant, readableError } from "@/lib/api";
import "./assistant.css";

interface Turn {
  role: "user" | "assistant";
  text: string;
}

/**
 * The help panel, on every signed-in screen.
 *
 * ============================================================
 * WHY A PANEL AND NOT A HELP PAGE
 * ============================================================
 *
 * A documentation page answers the questions somebody thought to look up. The
 * questions that actually stop people are the ones they do not know how to
 * phrase — "where do I put the number", "why can I not see the other business",
 * "did that send". Those get asked out loud or not at all, and if there is
 * nobody to ask they get abandoned.
 *
 * So it sits beside the work rather than replacing it, keeps the conversation
 * while the person moves between screens, and starts closed so it is never in
 * the way.
 *
 * ============================================================
 * WHAT IT IS HONEST ABOUT
 * ============================================================
 *
 * It explains and cannot act. The suggested openers are phrased as questions
 * rather than commands for that reason — "How do I add a client?" invites the
 * answer it can give, where "Add a client for me" invites the one it cannot.
 */
export function Assistant() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function ask(question: string) {
    const trimmed = question.trim();
    if (!trimmed || busy) return;

    // Shown immediately. Waiting for the server to echo it back makes a fast
    // typist think their message was lost.
    const withQuestion: Turn[] = [...turns, { role: "user", text: trimmed }];
    setTurns(withQuestion);
    setDraft("");
    setBusy(true);
    setError(null);

    try {
      const result = await askAssistant(trimmed, turns);
      setTurns([...withQuestion, { role: "assistant", text: result.answer }]);
    } catch (err) {
      // The question stays on screen. Removing it would make somebody retype
      // what they had just written.
      setError(readableError(err, "I could not answer just now."));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="as-open" onClick={() => setOpen(true)} aria-label="Ask for help">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.3-.6L3 21l1.8-5a8.2 8.2 0 0 1-.8-3.5 8.4 8.4 0 0 1 8.5-8.4 8.4 8.4 0 0 1 8.5 8.4Z" />
        </svg>
        <span>Ask</span>
      </button>
    );
  }

  return (
    <aside className="as" aria-label="Help assistant">
      <header className="as-head">
        <div>
          <strong>Ask about Nexus</strong>
          <span>Explains how the platform works. It cannot change anything.</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
      </header>

      <div className="as-body">
        {turns.length === 0 ? (
          <div className="as-empty">
            <p>Ask anything about using this platform.</p>
            <ul>
              {[
                "How do I add a client?",
                "Where do I put my WhatsApp number?",
                "Why can I only see one business?",
                "How do I send a campaign?",
                "Can I connect the WhatsApp on my phone?",
              ].map((q) => (
                <li key={q}>
                  <button type="button" onClick={() => ask(q)}>{q}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          turns.map((turn, i) => (
            <div key={i} className={`as-turn as-${turn.role}`}>
              {turn.text}
            </div>
          ))
        )}
        {busy ? <div className="as-turn as-assistant as-thinking">Thinking&hellip;</div> : null}
        {error ? <p className="as-error">{error}</p> : null}
        <div ref={endRef} />
      </div>

      <form
        className="as-ask"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask a question…"
          aria-label="Your question"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !draft.trim()}>Ask</button>
      </form>
    </aside>
  );
}
