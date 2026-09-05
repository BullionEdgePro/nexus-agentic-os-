"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ConversationSummary } from "@nexus/shared";
import { useInboxStore } from "@/lib/store";
import { useVisibleBusinesses } from "@/lib/business-tabs";
import { useInboxSocket } from "@/lib/use-inbox-socket";
import { ConversationTasks } from "./conversation-tasks";
import { ConversationCustody } from "./conversation-custody";
import { TagEditor } from "./tag-editor";
import "./inbox.css";

// ============================================================
// The folders down the side of a team inbox.
// ============================================================
//
// Each is a plain predicate over a conversation, applied client-side to the
// business's loaded list — the same place "Mine" already lived. The point of a
// folder is not to hide work but to let a person answer one question at a time:
// "who is waiting on me", "who has nobody", "who has been waiting too long".
//
// Everything here is derivable from data the summary already carries, so no
// folder promises more than the row can back up. Deliberately NOT "Unread":
// the platform tracks no per-viewer read state, and a folder that silently
// meant something else would be the kind of confident-wrong answer this
// codebase keeps having to unlearn.

type FolderKey =
  | "mine"
  | "all"
  | "awaiting"
  | "waiting"
  | "unassigned"
  | "human"
  | "open"
  | "closed";

// How long a customer's unanswered message sits before the inbox calls it out.
// Matches the spirit of the operators deck's "waiting" flag; a folder, not an
// SLA contract, so a round number rather than a per-business policy.
const WAITING_HOURS = 3;

function isWaitingTooLong(c: ConversationSummary): boolean {
  if (c.lastMessageDirection !== "inbound" || !c.lastMessageAt) return false;
  return Date.now() - new Date(c.lastMessageAt).getTime() > WAITING_HOURS * 3600_000;
}

function matchesFolder(c: ConversationSummary, folder: FolderKey, me: string | null): boolean {
  switch (folder) {
    case "mine":
      return !!me && c.assignedEmployeeId === me;
    case "all":
      return true;
    case "awaiting":
      // The customer spoke last and nobody has answered.
      return c.lastMessageDirection === "inbound";
    case "waiting":
      return isWaitingTooLong(c);
    case "unassigned":
      return c.assignedEmployeeId == null;
    case "human":
      return c.isHumanHandoff;
    case "open":
      return c.status === "open" || c.status === "pending";
    case "closed":
      return c.status === "resolved" || c.status === "closed";
  }
}

const STAFF_FOLDERS: { key: FolderKey; label: string }[] = [
  { key: "mine", label: "Mine" },
  { key: "all", label: "All" },
  { key: "awaiting", label: "Awaiting reply" },
  { key: "waiting", label: `Waiting >${WAITING_HOURS}h` },
  { key: "unassigned", label: "Unassigned" },
  { key: "human", label: "Human-held" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
];
// An operator owns no conversations personally, so "Mine" would be an always
// empty folder for them — dropped rather than shown broken.
const OPERATOR_FOLDERS = STAFF_FOLDERS.filter((f) => f.key !== "mine");

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

  // Which folder is open. A staff member lands on "Mine" the moment we know who
  // they are — the question they came to answer ("who is waiting for me?") — and
  // an operator, who owns no conversations personally, starts on "All".
  const [folder, setFolder] = useState<FolderKey>("all");
  const folderChosen = useRef(false);
  useEffect(() => {
    if (folderChosen.current) return;
    if (myEmployeeId) {
      setFolder("mine");
      folderChosen.current = true;
    } else if (known && !myEmployeeId) {
      folderChosen.current = true;
    }
  }, [known, myEmployeeId]);

  const selectedOrg = useInboxStore((s) => s.selectedOrg);
  const setSelectedOrg = useInboxStore((s) => s.setSelectedOrg);
  const conversations = useInboxStore((s) => s.conversations);
  const isLoadingConversations = useInboxStore((s) => s.isLoadingConversations);
  const selectedConversationId = useInboxStore((s) => s.selectedConversationId);
  const selectConversation = useInboxStore((s) => s.selectConversation);
  const setHumanHandoff = useInboxStore((s) => s.setHumanHandoff);
  const setTags = useInboxStore((s) => s.setTags);
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
  // A single label to narrow the list to, on top of the folder. Cleared when the
  // business changes, since a label from one business is meaningless in another.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  useEffect(() => {
    setTagFilter(null);
  }, [selectedOrg]);

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

  // The folders offered, and a live count on each — so a person can see where
  // the work is without opening every one, and "Mine (0)" is honest rather than
  // a folder that looks broken when empty.
  const folders = myEmployeeId ? STAFF_FOLDERS : OPERATOR_FOLDERS;
  const counts = useMemo(() => {
    const out = {} as Record<FolderKey, number>;
    for (const f of folders) out[f.key] = conversations.filter((c) => matchesFolder(c, f.key, myEmployeeId)).length;
    return out;
  }, [conversations, folders, myEmployeeId]);
  // Every label in use across the loaded inbox — the vocabulary for the filter
  // chips and the editor's suggestions, sorted so it is stable to read.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) for (const t of c.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const visibleConversations = conversations.filter(
    (c) => matchesFolder(c, folder, myEmployeeId) && (!tagFilter || c.tags.includes(tagFilter))
  );

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
        {/* The folders. Nothing until the role is known, so a staff member never
            sees "Mine" flash for an operator or vice versa. */}
        {known ? (
          <div className="ibx-folders" role="tablist" aria-label="Filter conversations">
            {folders.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={folder === f.key}
                className={`ibx-folder${folder === f.key ? " on" : ""}${
                  f.key === "waiting" && counts[f.key] > 0 ? " urgent" : ""
                }`}
                onClick={() => setFolder(f.key)}
              >
                {f.label}
                <span className="ibx-folder-n">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        ) : null}
        {/* Narrow to one label, on top of the folder. Only shown once the
            business actually uses labels, so it never sits there empty. */}
        {allTags.length ? (
          <div className="ibx-tagfilter" aria-label="Filter by label">
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                className={`ibx-tagchip${tagFilter === t ? " on" : ""}`}
                aria-pressed={tagFilter === t}
                onClick={() => setTagFilter((cur) => (cur === t ? null : t))}
              >
                {t}
              </button>
            ))}
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
            {conversations.length === 0
              ? "No conversations yet for this business."
              : folder === "mine"
                ? "None of this business's conversations are yours yet. A customer who opens a chat through your link, or one handed to you, will appear here."
                : folder === "waiting"
                  ? "Nobody has been left waiting — every customer who spoke last has had a reply."
                  : "Nothing in this folder right now."}
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
                    {/* The customer spoke last — this thread is waiting on us.
                        Turns amber once it has been waiting too long. */}
                    {conversation.lastMessageDirection === "inbound" && (
                      <span
                        className={`ibx-await${isWaitingTooLong(conversation) ? " late" : ""}`}
                        title={isWaitingTooLong(conversation) ? "Waiting too long" : "Waiting on a reply"}
                        aria-hidden="true"
                      />
                    )}
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
                  {conversation.tags.length ? (
                    <span className="ibx-row-tags">
                      {conversation.tags.slice(0, 3).map((t) => (
                        <span key={t} className="ibx-row-tag">
                          {t}
                        </span>
                      ))}
                      {conversation.tags.length > 3 ? (
                        <span className="ibx-row-tag ibx-row-tag-more">
                          +{conversation.tags.length - 3}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
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
                <TagEditor
                  key={activeConversation.id}
                  tags={activeConversation.tags}
                  suggestions={allTags}
                  onChange={(next) => setTags(activeConversation.id, next)}
                />
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
