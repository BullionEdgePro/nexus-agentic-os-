"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInboxStore } from "@/lib/store";
import { useVisibleBusinesses } from "@/lib/business-tabs";
import { useInboxSocket } from "@/lib/use-inbox-socket";
import { ConversationTasks } from "./conversation-tasks";
import { ConversationCustody } from "./conversation-custody";
import "./inbox.css";

export default function InboxPage() {
  useInboxSocket();

  // WHOSE BUSINESSES THESE ARE.
  //
  // This column was built from a hardcoded list of every business on the
  // platform, so a staff member assigned to one of them saw all five and could
  // click any of them. The API refused four -- the scoping was never the
  // problem -- but a column of names somebody cannot open is the same mistake
  // the rail already fixed: it teaches that the product is broken rather than
  // that the screen is not theirs, and it hands a staff member the client list
  // of four businesses they have nothing to do with, by name.
  //
  // The hook fails closed: if it cannot establish who is asking, it shows
  // nothing rather than everything.
  const { businesses, known, myEmployeeId } = useVisibleBusinesses();

  // "Mine" vs the whole business list. A staff member on a shared number sees
  // every conversation their business handles; this narrows it to the ones a
  // customer opened with THEM — assigned by their own link or handed to them.
  // Defaults to "mine" the moment we know who they are, because that is the
  // question they came to answer ("who is waiting for me?"); an operator has no
  // employee id, so the toggle never appears and they always see everything.
  const [scope, setScope] = useState<"mine" | "all">("all");
  const scopeChosen = useRef(false);
  useEffect(() => {
    if (scopeChosen.current) return;
    if (myEmployeeId) {
      setScope("mine");
      scopeChosen.current = true;
    } else if (known && !myEmployeeId) {
      // Role is known and there is no employee id — an operator. Lock to "all".
      scopeChosen.current = true;
    }
  }, [known, myEmployeeId]);

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

  // A SELECTION THAT SURVIVED THE NARROWING.
  //
  // The chosen business is remembered across visits and defaults to the first
  // in the old hardcoded list. A staff member at a different business would
  // therefore land on somebody else's tab, ask for its conversations, and get a
  // 403 rendered as "could not load" -- a permissions boundary working exactly
  // as designed and reading as a broken screen.
  useEffect(() => {
    if (!known || businesses.length === 0) return;
    if (businesses.some((option) => option.slug === selectedOrg)) return;
    setSelectedOrg(businesses[0].slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known, businesses, selectedOrg]);

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
    if (business && businesses.some((option) => option.slug === business)) {
      if (business !== selectedOrg) setSelectedOrg(business as typeof selectedOrg);
    }
    if (conversation) selectConversation(conversation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const activeConversation = conversations.find((c) => c.id === selectedConversationId);
  const messages = selectedConversationId ? messagesByConversation[selectedConversationId] ?? [] : [];

  // How many of this business's conversations are this person's own — shown on
  // the toggle so "Mine" is not a leap of faith when the filtered list is empty.
  const mineCount = myEmployeeId
    ? conversations.filter((c) => c.assignedEmployeeId === myEmployeeId).length
    : 0;
  const visibleConversations =
    scope === "mine" && myEmployeeId
      ? conversations.filter((c) => c.assignedEmployeeId === myEmployeeId)
      : conversations;

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
          {/* Nothing at all until the role is known. Rendering the full list
              first and narrowing it a moment later would show every business's
              name to a staff member for exactly as long as it takes to read. */}
          {known
            ? businesses.map((option) => (
                <li key={option.slug}>
                  <button
                    onClick={() => setSelectedOrg(option.slug)}
                    className={`ibx-biz-btn${selectedOrg === option.slug ? " on" : ""}`}
                    aria-current={selectedOrg === option.slug ? "true" : undefined}
                  >
                    {option.name}
                  </button>
                </li>
              ))
            : null}
        </ul>
      </aside>

      <section className="ibx-col ibx-convos">
        <h2 className="ibx-head">Conversations</h2>
        {/* Only a staff member has a "mine" — an operator owns none of the
            conversations personally, so the toggle would offer them an always
            empty list. Shown only once we know who they are. */}
        {myEmployeeId ? (
          <div className="ibx-scope" role="tablist" aria-label="Which conversations to show">
            <button
              type="button"
              role="tab"
              aria-selected={scope === "mine"}
              className={`ibx-scope-btn${scope === "mine" ? " on" : ""}`}
              onClick={() => setScope("mine")}
            >
              Mine{mineCount > 0 ? ` (${mineCount})` : ""}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={scope === "all"}
              className={`ibx-scope-btn${scope === "all" ? " on" : ""}`}
              onClick={() => setScope("all")}
            >
              All
            </button>
          </div>
        ) : null}
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
        ) : visibleConversations.length === 0 ? (
          <p className="ibx-empty">
            {scope === "mine"
              ? "None of this business's conversations are yours yet. A customer who opens a chat through your link, or one handed to you, will appear here."
              : "No conversations yet for this business."}
          </p>
        ) : (
          <ul className="ibx-list">
            {visibleConversations.map((conversation) => (
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
              {/* The checkbox shows one boolean; six different things in the
                  platform can set it, and until migration 062 nothing recorded
                  which. The history sits directly under the control it
                  explains, because that is where the question gets asked. */}
              <div className="ibx-handoff-block">
                <label className="ibx-handoff">
                  Human handoff
                  <input
                    type="checkbox"
                    checked={activeConversation.isHumanHandoff}
                    onChange={(e) => setHumanHandoff(activeConversation.id, e.target.checked)}
                  />
                </label>
                <ConversationCustody
                  key={activeConversation.id}
                  conversationId={activeConversation.id}
                />
              </div>
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
