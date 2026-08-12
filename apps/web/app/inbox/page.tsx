"use client";

import { useEffect, useState } from "react";
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

  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg]);

  const activeConversation = conversations.find((c) => c.id === selectedConversationId);
  const messages = selectedConversationId ? messagesByConversation[selectedConversationId] ?? [] : [];

  async function handleSend() {
    if (!selectedConversationId || !draft.trim()) return;
    setIsSending(true);
    try {
      await sendMessage(selectedConversationId, draft.trim());
      setDraft("");
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
