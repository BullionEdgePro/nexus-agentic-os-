"use client";

import { useEffect, useState } from "react";
import { useInboxStore, BUSINESS_OPTIONS } from "@/lib/store";
import { useInboxSocket } from "@/lib/use-inbox-socket";

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
    <div className="grid h-full grid-cols-[220px_320px_1fr]">
      <aside className="border-r border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Businesses
        </h2>
        <ul className="space-y-1">
          {BUSINESS_OPTIONS.map((option) => (
            <li key={option.slug}>
              <button
                onClick={() => setSelectedOrg(option.slug)}
                className={`w-full rounded px-2 py-1.5 text-left text-sm ${
                  selectedOrg === option.slug
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-400 hover:bg-neutral-900"
                }`}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="border-r border-neutral-800 p-4">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-400">
          Conversations
        </h2>
        {isLoadingConversations ? (
          <p className="text-sm text-neutral-500">Loading…</p>
        ) : conversations.length === 0 ? (
          <p className="text-sm text-neutral-500">No conversations yet for this business.</p>
        ) : (
          <ul className="space-y-1">
            {conversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  onClick={() => selectConversation(conversation.id)}
                  className={`w-full rounded px-2 py-2 text-left ${
                    selectedConversationId === conversation.id
                      ? "bg-neutral-800"
                      : "hover:bg-neutral-900"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">
                      {conversation.contactName ?? conversation.contactWaId}
                    </span>
                    {conversation.isHumanHandoff && (
                      <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-400">
                        human
                      </span>
                    )}
                  </div>
                  <p className="truncate text-xs text-neutral-500">
                    {conversation.lastMessagePreview ?? "No messages yet"}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col p-4">
        {!activeConversation ? (
          <p className="text-sm text-neutral-500">Select a conversation to view messages.</p>
        ) : (
          <>
            <header className="mb-3 flex items-center justify-between border-b border-neutral-800 pb-3">
              <div>
                <h1 className="text-base font-semibold">
                  {activeConversation.contactName ?? activeConversation.contactWaId}
                </h1>
                <p className="text-xs text-neutral-500">{activeConversation.contactWaId}</p>
              </div>
              <label className="flex items-center gap-2 text-xs text-neutral-400">
                Human handoff
                <input
                  type="checkbox"
                  checked={activeConversation.isHumanHandoff}
                  onChange={(e) => setHumanHandoff(activeConversation.id, e.target.checked)}
                />
              </label>
            </header>
            <div className="flex-1 space-y-2 overflow-y-auto">
              {messages.map((message) => (
                <div
                  key={message.id}
                  className={`max-w-md rounded px-3 py-2 text-sm ${
                    message.direction === "inbound"
                      ? "bg-neutral-800"
                      : "ml-auto bg-blue-600 text-white"
                  }`}
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
              className="mt-3 flex gap-2 border-t border-neutral-800 pt-3"
            >
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Reply as a human agent…"
                className="flex-1 rounded bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600"
              />
              <button
                type="submit"
                disabled={isSending || !draft.trim()}
                className="rounded bg-blue-600 px-4 py-2 text-sm font-medium disabled:opacity-50"
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
