"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInboxStore, BUSINESS_OPTIONS } from "@/lib/store";
import { useInboxSocket } from "@/lib/use-inbox-socket";
import { ConversationTasks } from "./conversation-tasks";
import "./inbox.css";

export default function InboxPage() {
  useInboxSocket();

  const selectedOrg = useInboxStore((s) => s.selectedOrg);
  const setSelectedOrg = useInboxStore((s) => s.setSelectedOrg);
  const conversations = useInboxStore((s) => s.conversations);
  const isLoadingConversations = useInboxStore((s) => s.isLoadingConversations);
  const selectedConversationId = useInboxStore((s) => s.selectedConversationId);
  const selectConversation = useInboxStore((s) => s.selectConversation);
  const setHumanHandoff = useInboxStore((s) => s.setHumanHandoff);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const messagesByConversation = useInboxStore((s) => s.messagesByConversation);
  const loadConversations = useInboxStore((s) => s.loadConversations);
  const loadError = useInboxStore((s) => s.loadError);
  const sendError = useInboxStore((s) => s.sendError);

  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg]);

  // ARRIVING FROM A LINK, which until now was not possible.
  //
  // The operators deck lists what is wrong -- "Ahmed has been waiting 3 hours"
  // -- and the only way to reach that conversation was to come here and find
  // the name by eye. The finding knew exactly which conversation it meant and
  // had no way to say so, because this page kept its selection in a client
  // store and read nothing from the URL.
  //
  // Applied ONCE, on arrival. Re-applying would fight the person: click a
  // different conversation and a re-render would drag them back to the one the
  // link named. `applied` is a ref rather than state so setting it cannot
  // itself cause the render that re-runs this.
  const params = useSearchParams();
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;

    const business = params.get("business");
    const conversation = params.get("conversation");
    if (!business && !conversation) return;

    applied.current = true;

    // The business first: setSelectedOrg clears the selected conversation and
    // the loaded list, so choosing a conversation before it would be undone
    // half a line later.
    if (business && BUSINESS_OPTIONS.some((option) => option.slug === business)) {
      if (business !== selectedOrg) setSelectedOrg(business as typeof selectedOrg);
    }
    if (conversation) selectConversation(conversation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const activeConversation = conversations.find((c) => c.id === selectedConversationId);
  const messages = selectedConversationId ? messagesByConversation[selectedConversationId] ?? [] : [];

  async function handleSend() {
    if (!selectedConversationId || !draft.trim()) return;
    setIsSending(true);
    try {
      await sendMessage(selectedConversationId, draft.trim());
      setDraft("");
    } catch {
      // The store has already recorded why, and it is rendered beside the box.
      // Swallowed here so a failed send does not become an unhandled rejection
      // — the draft stays exactly where it was typed, which is the only copy of
      // it that exists.
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="ibx">
      <aside className="ibx-col ibx-biz">
        <h2 className="ibx-head">Businesses</h2>
        <ul className="ibx-list">
          {BUSINESS_OPTIONS.map((option) => (
            <li key={option.slug}>
              <button
                onClick={() => setSelectedOrg(option.slug)}
                className={`ibx-biz-btn${selectedOrg === option.slug ? " on" : ""}`}
                aria-current={selectedOrg === option.slug ? "true" : undefined}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="ibx-col ibx-convos">
        <h2 className="ibx-head">Conversations</h2>
        {isLoadingConversations ? (
          <p className="ibx-empty">Loading…</p>
        ) : loadError ? (
          /*
           * NOT "No conversations yet".
           *
           * A failed load used to render the empty state, which on this screen
           * reads as "nobody needs you" — on the one page a person opens to
           * find out whether a customer is waiting. The list is left untouched
           * rather than cleared, and simply not drawn: an emptied list would
           * produce the same sentence by a different route.
           */
          <p className="ibx-empty ibx-failed">
            <strong>Could not load conversations.</strong>
            <br />
            {loadError}
            <br />
            This is not the same as having none — nothing was read, so nothing can be said
            about who is waiting.
          </p>
        ) : conversations.length === 0 ? (
          <p className="ibx-empty">No conversations yet for this business.</p>
        ) : (
          <ul className="ibx-list">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  onClick={() => selectConversation(conversation.id)}
                  className={`ibx-convo${selectedConversationId === conversation.id ? " on" : ""}`}
                  aria-current={selectedConversationId === conversation.id ? "true" : undefined}
                >
                  <div className="ibx-convo-top">
                    <span className="ibx-convo-name">
                      {conversation.contactName ?? conversation.contactWaId}
                    </span>
                    {conversation.isHumanHandoff && (
                      <span className="ibx-flag">human</span>
                    )}
                  </div>
                  <p className="ibx-preview">
                    {conversation.lastMessagePreview ?? "No messages yet"}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ibx-thread">
        {!activeConversation ? (
          <p className="ibx-empty">Select a conversation to view messages.</p>
        ) : (
          <>
            <header className="ibx-thread-head">
              <div>
                <h1 className="ibx-who">
                  {activeConversation.contactName ?? activeConversation.contactWaId}
                </h1>
                <p className="ibx-wa">+{activeConversation.contactWaId}</p>
              </div>
              <label className="ibx-handoff">
                Human handoff
                <input
                  type="checkbox"
                  checked={activeConversation.isHumanHandoff}
                  onChange={(e) => setHumanHandoff(activeConversation.id, e.target.checked)}
                />
              </label>
            </header>
            {/* Keyed on the conversation so switching customers resets the
                draft — without it, a half-typed follow-up for one person
                would still be sitting in the box for the next. */}
            <ConversationTasks key={activeConversation.id} conversationId={activeConversation.id} />
            <div className="ibx-msgs">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`ibx-bubble ${message.direction === "inbound" ? "in" : "out"}`}
                >
                  {message.body}
                </div>
              ))}
            </div>
            {sendError ? (
              /*
               * A SEND THAT FAILED SAID NOTHING AT ALL.
               *
               * The spinner stopped, the draft stayed in the box, and there was
               * no way to tell that from a send that worked. Meta refusing a
               * message outside the 24-hour session window is the common one,
               * and it happens precisely when somebody is replying to a customer
               * who has been waiting — the case where believing it went is worst.
               */
              <p className="ibx-send-failed">
                <strong>Not sent.</strong> {sendError} Your message is still in the box below.
              </p>
            ) : null}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSend();
              }}
              className="ibx-compose"
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Reply as a human agent…"
                className="ibx-input"
              />
              <button
                type="submit"
                disabled={isSending || !draft.trim()}
                className="ibx-send"
              >
                Send
              </button>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
