"use client";

import { useEffect, useState } from "react";
import { getTeamThreads, openDirectChat, readableError, sendTeamMessage, type TeamColleague } from "@/lib/api";

/**
 * "Ask a colleague" — hand a customer's chat to a colleague in Team chat
 * (24 Oct 2026).
 *
 * Posts a card into the direct chat with that colleague. Because customer
 * chats are private to the person they belong to, sending the card ALSO adds
 * the colleague to this chat — said in plain words before anything is sent,
 * so nobody gives access without knowing it.
 */
export function AskColleague({ conversationId, customerName }: { conversationId: string; customerName: string }) {
  const [open, setOpen] = useState(false);
  const [colleagues, setColleagues] = useState<TeamColleague[] | null>(null);
  const [chosen, setChosen] = useState<TeamColleague | null>(null);
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState("");

  // "A" in the inbox, or the command bar, opens it (Focus workspace).
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener("nexus:ask-colleague", show);
    return () => window.removeEventListener("nexus:ask-colleague", show);
  }, []);

  useEffect(() => {
    if (!open || colleagues) return;
    getTeamThreads()
      .then((data) => setColleagues(data.colleagues))
      .catch((err) => setError(readableError(err, "Your colleagues could not be loaded.")));
  }, [open, colleagues]);

  function close() {
    setOpen(false);
    setChosen(null);
    setNote("");
    setState("idle");
    setError("");
  }

  async function send() {
    if (!chosen) return;
    setState("sending");
    setError("");
    try {
      const { thread } = await openDirectChat(chosen.id);
      await sendTeamMessage(thread.id, {
        clientId: crypto.randomUUID(),
        body: note.trim() || `Could you help me with ${customerName}?`,
        shareConversationId: conversationId,
      });
      setState("sent");
    } catch (err) {
      setState("idle");
      setError(readableError(err, "That could not be sent."));
    }
  }

  return (
    <div className="ibx-ask">
      <button type="button" className="ibx-notcust" onClick={() => (open ? close() : setOpen(true))}>
        <span>Ask a colleague</span>
      </button>
      {open ? (
        <div className="ibx-ask-pop" role="dialog" aria-label="Ask a colleague">
          {state === "sent" && chosen ? (
            <>
              <p>
                Sent to <b>{chosen.fullName}</b>. They can open this chat now.
              </p>
              <div className="ibx-ask-row">
                <a href="/deck/team-chat">Open Team chat</a>
                <button type="button" onClick={close}>
                  Done
                </button>
              </div>
            </>
          ) : !chosen ? (
            <>
              <p className="ibx-ask-head">Who should help with {customerName}?</p>
              {colleagues === null && !error ? <p className="ibx-ask-muted">Loading…</p> : null}
              {colleagues?.length === 0 ? <p className="ibx-ask-muted">Nobody else works here yet.</p> : null}
              <ul>
                {colleagues?.map((c) => (
                  <li key={c.id}>
                    <button type="button" onClick={() => setChosen(c)}>
                      <i className={`ibx-ask-dot${c.onShift ? " on" : ""}`} aria-hidden="true" />
                      {c.fullName}
                      <small>{c.onShift ? "On shift" : "Off shift"}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className="ibx-ask-head">Message to {chosen.fullName}</p>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={`Could you help me with ${customerName}?`}
                rows={3}
                maxLength={1000}
              />
              <p className="ibx-ask-warn">Gives {chosen.fullName} access to this chat.</p>
              <div className="ibx-ask-row">
                <button type="button" onClick={() => setChosen(null)}>
                  Back
                </button>
                <button type="button" className="primary" disabled={state === "sending"} onClick={() => void send()}>
                  {state === "sending" ? "Sending…" : "Send"}
                </button>
              </div>
            </>
          )}
          {error ? <p className="ibx-ask-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
