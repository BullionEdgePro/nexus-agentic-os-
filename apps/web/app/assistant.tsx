"use client";

import { useEffect, useRef, useState } from "react";
import { askAssistant, readFileForAssistant, readableError, type AssistantFile } from "@/lib/api";
import "./assistant.css";

interface Turn {
  role: "user" | "assistant";
  text: string;
  /** Names only. The bytes are sent and forgotten, not held in the panel. */
  files?: string[];
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
 * It explains and cannot act ON THIS PLATFORM — the openers about Nexus are
 * phrased as questions for that reason, since "Add a client for me" invites the
 * answer it cannot give.
 *
 * It will happily DO other work, though: draft a message, read a document,
 * translate. That distinction is the whole design, and the header says it in
 * one line so nobody has to discover it by being refused.
 */
export function Assistant() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<AssistantFile[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, busy]);

  async function ask(question: string) {
    const trimmed = question.trim();
    // A file on its own is a question — "what is this?" is implied, and making
    // somebody type it before the button works is a pointless gate.
    if ((!trimmed && files.length === 0) || busy) return;
    const asked = trimmed || (files.length === 1 ? "What is this?" : "What are these?");

    // Shown immediately. Waiting for the server to echo it back makes a fast
    // typist think their message was lost.
    const withQuestion: Turn[] = [
      ...turns,
      { role: "user", text: asked, files: files.map((f) => f.name) },
    ];
    setTurns(withQuestion);
    setDraft("");
    setBusy(true);
    setError(null);

    // Cleared before the call, not after. Otherwise a slow answer leaves the
    // files sitting in the box looking as though they had not been sent.
    const sending = files;
    setFiles([]);

    try {
      // History carries only the text of previous turns. Re-sending every
      // attachment on every question would multiply the cost of a long
      // conversation by the size of its largest file.
      const result = await askAssistant(asked, turns.map(({ role, text }) => ({ role, text })), sending);
      setTurns([...withQuestion, { role: "assistant", text: result.answer }]);
    } catch (err) {
      // The question stays on screen. Removing it would make somebody retype
      // what they had just written.
      setError(readableError(err, "I could not answer just now."));
    } finally {
      setBusy(false);
    }
  }

  async function attach(list: FileList | null) {
    if (!list?.length) return;
    setError(null);
    try {
      const read = await Promise.all(Array.from(list).slice(0, 4).map(readFileForAssistant));
      setFiles((current) => [...current, ...read].slice(0, 4));
    } catch (err) {
      setError(readableError(err, "That file could not be read."));
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
          <strong>Ask anything</strong>
          <span>Nexus, your work, or a file you send. It cannot change anything here.</span>
        </div>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
      </header>

      <div className="as-body">
        {turns.length === 0 ? (
          <div className="as-empty">
            <p>
              Ask about this platform, or anything else — draft a reply, check a document,
              translate something. Attach an image, PDF or text file with the clip.
            </p>
            <ul>
              {[
                "How do I add a client?",
                "Where do I put my WhatsApp number?",
                "Why can I only see one business?",
                "How do I send a campaign?",
                "Draft a polite reply to an angry customer.",
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
              {turn.files?.length ? (
                <div className="as-files">
                  {turn.files.map((name) => (
                    <span key={name}>{name}</span>
                  ))}
                </div>
              ) : null}
              {turn.text}
            </div>
          ))
        )}
        {busy ? <div className="as-turn as-assistant as-thinking">Thinking&hellip;</div> : null}
        {error ? <p className="as-error">{error}</p> : null}
        <div ref={endRef} />
      </div>

      {files.length ? (
        <div className="as-tray">
          {files.map((file) => (
            <span key={file.name}>
              {file.name}
              <button
                type="button"
                onClick={() => setFiles((current) => current.filter((f) => f.name !== file.name))}
                aria-label={`Remove ${file.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}

      <form
        className="as-ask"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        {/* Types listed on the input itself, so the file browser filters rather
            than letting somebody pick a video and be told no afterwards. */}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/plain,text/csv,text/markdown,application/json,text/html"
          onChange={(event) => {
            void attach(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="as-clip"
          onClick={() => picker.current?.click()}
          disabled={busy}
          aria-label="Attach a file"
          title="Attach an image, PDF or text file"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M21.4 11.05 12.25 20.2a6 6 0 0 1-8.49-8.49l9.2-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Ask a question…"
          aria-label="Your question"
          disabled={busy}
        />
        <button type="submit" disabled={busy || (!draft.trim() && files.length === 0)}>Ask</button>
      </form>
    </aside>
  );
}
