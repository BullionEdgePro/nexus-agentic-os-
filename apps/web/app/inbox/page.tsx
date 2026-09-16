"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ConversationSummary, ConversationChannel } from "@nexus/shared";
import { suggestReply, polishText, syncGmailInbox, readableError } from "@/lib/api";
import { useInboxStore } from "@/lib/store";
import { useVisibleBusinesses } from "@/lib/business-tabs";
import { useInboxSocket } from "@/lib/use-inbox-socket";
import { ConversationTasks } from "./conversation-tasks";
import { ConversationCustody } from "./conversation-custody";
import { TagEditor } from "./tag-editor";
import { DetailsPanel } from "./details-panel";
import { ScheduledMessages } from "./scheduled-messages";
import { QuickReplies } from "./quick-replies";
import { CallLogPanel } from "./call-log";
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
  | "followup"
  | "unassigned"
  | "human"
  | "open"
  | "closed";

// How long a customer's unanswered message sits before the inbox calls it out.
// Matches the spirit of the operators deck's "waiting" flag; a folder, not an
// SLA contract, so a round number rather than a per-business policy.
const WAITING_HOURS = 3;

// The pipeline stages, in the order a lead moves through them — the same set the
// details panel sets, kept here so the inbox can offer them as category filters
// and show them in that order rather than alphabetically.
const LEAD_STAGE_ORDER = ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"];

// How each channel reads in the inbox — a glyph for the row badge and a word for
// the filter and the thread header. WhatsApp is the only one live today; the
// rest are here so an email or SMS conversation, once its adapter is connected,
// slots straight in with a badge that already means something.
const CHANNEL_META: Record<ConversationChannel, { glyph: string; label: string }> = {
  whatsapp: { glyph: "💬", label: "WhatsApp" },
  email: { glyph: "✉️", label: "Email" },
  sms: { glyph: "📱", label: "SMS" },
  instagram: { glyph: "📷", label: "Instagram" },
  phone: { glyph: "📞", label: "Phone" },
};

function channelMeta(channel: string): { glyph: string; label: string } {
  return CHANNEL_META[channel as ConversationChannel] ?? { glyph: "💬", label: channel };
}

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
    case "followup":
      return c.hasOverdueFollowup;
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
  { key: "followup", label: "Follow-up due" },
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
  const socketStatus = useInboxStore((s) => s.socketStatus);

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
  // A pipeline stage to narrow to — the "category" a DoubleTick-style inbox
  // filters by (Prospect, Won, …), on top of the folder. Same field the details
  // panel sets; cleared when the business changes.
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  // Which channel to narrow to — only ever offered once a business has more than
  // one, so it stays invisible until multi-channel actually means something here.
  const [channelFilter, setChannelFilter] = useState<string | null>(null);
  useEffect(() => {
    setTagFilter(null);
    setStageFilter(null);
    setChannelFilter(null);
  }, [selectedOrg]);

  useEffect(() => {
    loadConversations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg]);

  // BEST-EFFORT: pull this staff member's client email into the inbox as email
  // conversations when it opens. The sync is idempotent (deduped server-side), so
  // calling it on open never doubles anything; a newly-stored message triggers one
  // reload so it appears without a manual refresh. Runs once, and only for staff —
  // an operator has no mailbox and would get a 403, which is swallowed along with
  // the "Gmail not connected" case, because neither is a fault to raise on a
  // WhatsApp-only user just opening their inbox.
  const emailSynced = useRef(false);
  useEffect(() => {
    if (emailSynced.current || !myEmployeeId) return;
    emailSynced.current = true;
    syncGmailInbox()
      .then((r) => {
        if (r.newMessages > 0) loadConversations();
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myEmployeeId]);

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

  // The pipeline stages actually in use, in the pipeline's own order (not
  // alphabetical — "New" precedes "Won"). Only shown once a business uses them,
  // so the strip never sits there empty.
  const allStages = useMemo(() => {
    const present = new Set<string>();
    for (const c of conversations) if (c.leadStage) present.add(c.leadStage);
    return LEAD_STAGE_ORDER.filter((s) => present.has(s)).concat(
      [...present].filter((s) => !LEAD_STAGE_ORDER.includes(s)).sort((a, b) => a.localeCompare(b))
    );
  }, [conversations]);

  // The channels actually in use. Kept in a fixed order (WhatsApp first) so the
  // strip is stable, and only surfaced as a filter once a business has more than
  // one — a single-channel business gets no redundant "WhatsApp only" control.
  const allChannels = useMemo(() => {
    const present = new Set<string>();
    for (const c of conversations) present.add(c.channel);
    const order = ["whatsapp", "email", "sms", "instagram", "phone"];
    return order
      .filter((ch) => present.has(ch))
      .concat([...present].filter((ch) => !order.includes(ch)).sort((a, b) => a.localeCompare(b)));
  }, [conversations]);

  const visibleConversations = conversations.filter(
    (c) =>
      matchesFolder(c, folder, myEmployeeId) &&
      (!tagFilter || c.tags.includes(tagFilter)) &&
      (!stageFilter || c.leadStage === stageFilter) &&
      (!channelFilter || c.channel === channelFilter)
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

  // AI Assist, in the compose box. Both fill the draft and never send — a person
  // reads and sends. "ai" tracks which is running so the buttons can say so; the
  // error sits beside the box, cleared on the next try.
  const [ai, setAi] = useState<"" | "suggest" | "polish">("");
  const [aiError, setAiError] = useState<string | null>(null);
  async function handleSuggest() {
    if (!selectedConversationId || ai) return;
    setAi("suggest");
    setAiError(null);
    try {
      const { suggestion } = await suggestReply(selectedConversationId);
      setDraft(suggestion);
    } catch (err) {
      setAiError(readableError(err, "Could not draft a reply."));
    } finally {
      setAi("");
    }
  }
  async function handlePolish() {
    if (!selectedConversationId || ai || !draft.trim()) return;
    setAi("polish");
    setAiError(null);
    try {
      const { text } = await polishText(selectedConversationId, draft.trim());
      setDraft(text);
    } catch (err) {
      setAiError(readableError(err, "Could not polish that."));
    } finally {
      setAi("");
    }
  }

  return (
    <div className="ibx">
      {/* Live feed down and retrying. A fixed toast rather than a layout row,
          so it never reflows the columns; only shown for "closed" — "off" (no
          socket configured) and "connecting" are not faults to announce. */}
      {socketStatus === "closed" ? (
        <div className="ibx-offline" role="status" aria-live="polite">
          <span className="ibx-offline-dot" aria-hidden="true" />
          Live updates paused — reconnecting. New messages may be delayed.
        </div>
      ) : null}

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
                  (f.key === "waiting" || f.key === "followup") && counts[f.key] > 0 ? " urgent" : ""
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
        {/* Narrow to one pipeline stage — the "category" a DoubleTick-style
            inbox filters by. Only shown once a business actually stages its
            leads, in pipeline order. */}
        {allStages.length ? (
          <div className="ibx-stagefilter" aria-label="Filter by pipeline stage">
            {allStages.map((s) => (
              <button
                key={s}
                type="button"
                className={`ibx-stagechip${stageFilter === s ? " on" : ""}`}
                aria-pressed={stageFilter === s}
                onClick={() => setStageFilter((cur) => (cur === s ? null : s))}
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {/* Narrow to one channel — only shown once a business actually has more
            than one, so it never sits there as a lone "WhatsApp" chip. */}
        {allChannels.length > 1 ? (
          <div className="ibx-chanfilter" aria-label="Filter by channel">
            {allChannels.map((ch) => (
              <button
                key={ch}
                type="button"
                className={`ibx-chanchip${channelFilter === ch ? " on" : ""}`}
                aria-pressed={channelFilter === ch}
                onClick={() => setChannelFilter((cur) => (cur === ch ? null : ch))}
              >
                <span aria-hidden="true">{channelMeta(ch).glyph}</span> {channelMeta(ch).label}
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
                  : folder === "followup"
                    ? "No follow-ups are overdue. Add one from a conversation's Follow-ups panel."
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
                    {/* Which channel this thread is on — a glyph rather than a
                        word so the row stays scannable. */}
                    <span
                      className="ibx-convo-chan"
                      title={channelMeta(conversation.channel).label}
                      aria-label={channelMeta(conversation.channel).label}
                    >
                      {channelMeta(conversation.channel).glyph}
                    </span>
                    <span className="ibx-convo-name">
                      {conversation.contactName ?? conversation.contactWaId}
                    </span>
                    {conversation.isHumanHandoff && (
                      <span className="ibx-flag">human</span>
                    )}
                    {conversation.hasOverdueFollowup && (
                      <span className="ibx-flag ibx-flag-due" title="Follow-up overdue">
                        ⏰ follow-up
                      </span>
                    )}
                  </div>
                  <p className="ibx-preview">
                    {conversation.lastMessagePreview ?? "No messages yet"}
                  </p>
                  {conversation.leadStage ? (
                    <span className="ibx-row-stage">{conversation.leadStage}</span>
                  ) : null}
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
                <p className="ibx-wa">
                  <span className="ibx-thread-chan" title={channelMeta(activeConversation.channel).label}>
                    {channelMeta(activeConversation.channel).glyph} {channelMeta(activeConversation.channel).label}
                  </span>
                  {" · +"}
                  {activeConversation.contactWaId}
                </p>
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
            {/* Calls logged against this customer — a real CRM feature that does
                not need telephony: a person records that they rang, and how it
                went. A provider, once connected, writes the same rows. */}
            <CallLogPanel key={`calls-${activeConversation.id}`} conversationId={activeConversation.id} />
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
            {aiError ? <p className="ibx-ai-error">{aiError}</p> : null}
            {/* AI Assist. Both fill the box for a person to read and send — never
                a send of their own. Quick replies sit alongside: the same "fill
                the box, never send" contract, from the business's own library. */}
            <div className="ibx-ai-bar">
              <QuickReplies
                orgSlug={selectedOrg}
                draft={draft}
                onInsert={(body) =>
                  setDraft((current) => (current.trim() ? `${current.replace(/\s+$/, "")}\n${body}` : body))
                }
              />
              <button
                type="button"
                className="ibx-ai-btn"
                onClick={handleSuggest}
                disabled={!!ai}
                title="Draft a reply from the conversation so far"
              >
                {ai === "suggest" ? "Drafting…" : "✨ Suggest reply"}
              </button>
              <button
                type="button"
                className="ibx-ai-btn"
                onClick={handlePolish}
                disabled={!!ai || !draft.trim()}
                title="Fix spelling and grammar without changing what it says"
              >
                {ai === "polish" ? "Polishing…" : "Polish"}
              </button>
            </div>
            <ScheduledMessages
              key={activeConversation.id}
              conversationId={activeConversation.id}
              draft={draft}
              onScheduled={() => setDraft("")}
            />
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

      {/* The Details panel — who this customer is and the fields kept on them.
          Always the fourth column so the grid does not reflow when a
          conversation is opened; a placeholder until one is. */}
      <aside className="ibx-col ibx-details">
        <h2 className="ibx-head">Details</h2>
        {activeConversation ? (
          <DetailsPanel key={activeConversation.id} conversationId={activeConversation.id} />
        ) : (
          <p className="dp-empty">Select a conversation to see its details.</p>
        )}
      </aside>
    </div>
  );
}
