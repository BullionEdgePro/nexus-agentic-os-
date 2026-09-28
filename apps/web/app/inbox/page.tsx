"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ConversationSummary, ConversationChannel, MessageDto, TimelineItem } from "@nexus/shared";
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
import "./inbox.css";

// ============================================================
// The folders down the side of a team inbox.
// ============================================================
//
// Each is a plain predicate over a conversation, applied client-side to the
// business's loaded list. The point of a folder is not to hide work but to let a
// person answer one question at a time: "who is waiting on me", "who has
// nobody", "who has been waiting too long".
//
// "Unread" is PER PERSON (migration 090): it counts customer messages the
// viewer has not seen since they last opened the thread — not the customer's
// WhatsApp read receipt, which says nothing about whether anyone here saw it.

type FolderKey =
  | "mine"
  | "all"
  | "unread"
  | "awaiting"
  | "late"
  | "followup"
  | "unassigned"
  | "human"
  | "open"
  | "resolved";

// The pipeline stages and the reply-time target come from the business's own
// inbox settings (store.inboxSettings), not constants here — a law firm and a
// shop do not move leads through the same stages or promise the same speed.

// How each channel reads in the inbox — a glyph for the row badge and a word for
// the filter and the thread header.
const CHANNEL_META: Record<ConversationChannel, { glyph: string; label: string }> = {
  whatsapp: { glyph: "💬", label: "WhatsApp" },
  email: { glyph: "✉️", label: "Email" },
  sms: { glyph: "📱", label: "SMS" },
  instagram: { glyph: "📷", label: "Instagram" },
  phone: { glyph: "📞", label: "Phone" },
  facebook: { glyph: "📘", label: "Facebook" },
};

function channelMeta(channel: string): { glyph: string; label: string } {
  return CHANNEL_META[channel as ConversationChannel] ?? { glyph: "💬", label: channel };
}

// The channels a staff member answers, as always-present tabs. Any OTHER channel
// that has conversations (sms, phone) is appended so nothing is ever hidden
// behind "All".
const CHANNEL_TABS: ConversationChannel[] = ["whatsapp", "email", "facebook", "instagram"];

/** "2h 04m", "35m", "3d 2h" — how long a customer has been waiting. */
function waitedFor(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The SLA as a person says it: "3h", "45m", "1d". */
function slaLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** A row's time: "now", "12m", "3h", "Yesterday", "Mon", "12 Sep". */
function rowTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  const diff = now - t;
  if (diff < 60_000) return "now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m`;
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return `${Math.floor(diff / 3600_000)}h`;
  const yesterday = new Date(now - 86400_000);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (diff < 6 * 86400_000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  if (d.toDateString() === new Date(now).toDateString()) return "Today";
  if (d.toDateString() === new Date(now - 86400_000).toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

function isLate(c: ConversationSummary, slaMinutes: number, now: number): boolean {
  if (c.lastMessageDirection !== "inbound" || !c.lastMessageAt) return false;
  return now - new Date(c.lastMessageAt).getTime() > slaMinutes * 60_000;
}

function matchesFolder(
  c: ConversationSummary,
  folder: FolderKey,
  me: string | null,
  slaMinutes: number,
  now: number
): boolean {
  switch (folder) {
    case "mine":
      return !!me && c.assignedEmployeeId === me;
    case "all":
      return true;
    case "unread":
      return Number(c.unreadCount ?? 0) > 0;
    case "awaiting":
      // The customer spoke last and nobody has answered.
      return c.lastMessageDirection === "inbound";
    case "late":
      return isLate(c, slaMinutes, now);
    case "followup":
      return c.hasOverdueFollowup;
    case "unassigned":
      return c.assignedEmployeeId == null;
    case "human":
      return c.isHumanHandoff;
    case "open":
      return c.status === "open" || c.status === "pending";
    case "resolved":
      return c.status === "resolved" || c.status === "closed";
  }
}

function folderList(slaMinutes: number): { key: FolderKey; label: string }[] {
  return [
    { key: "mine", label: "Mine" },
    { key: "all", label: "All" },
    { key: "unread", label: "Unread" },
    { key: "awaiting", label: "Awaiting reply" },
    { key: "late", label: `SLA breached (>${slaLabel(slaMinutes)})` },
    { key: "followup", label: "Follow-up due" },
    { key: "unassigned", label: "Unassigned" },
    { key: "human", label: "Human-held" },
    { key: "open", label: "Open" },
    { key: "resolved", label: "Resolved" },
  ];
}

type DateRange = "any" | "today" | "7d" | "30d";
const DATE_RANGES: { key: DateRange; label: string; ms: number }[] = [
  { key: "any", label: "Any time", ms: 0 },
  { key: "today", label: "Last 24 hours", ms: 86400_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 86400_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 86400_000 },
];

/** Delivery ticks on our own messages — what Meta has told us about each. */
function Ticks({ status }: { status: MessageDto["status"] }) {
  switch (status) {
    case "queued":
      return <span className="ibx-tick" title="Queued">🕓</span>;
    case "sent":
      return <span className="ibx-tick" title="Sent">✓</span>;
    case "delivered":
      return <span className="ibx-tick" title="Delivered">✓✓</span>;
    case "read":
      return <span className="ibx-tick read" title="Read">✓✓</span>;
    case "failed":
      return <span className="ibx-tick failed" title="Not delivered">⚠ not delivered</span>;
    default:
      return null;
  }
}

type ThreadRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "msg"; key: string; at: string; message: MessageDto }
  | { kind: "item"; key: string; at: string; item: TimelineItem };

export default function InboxPage() {
  useInboxSocket();

  // WHOSE BUSINESSES THESE ARE. The hook fails closed: if it cannot establish
  // who is asking, it shows nothing rather than everything — a column of names
  // somebody cannot open teaches that the product is broken, and hands a staff
  // member the client list of businesses they have nothing to do with.
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
  const setStatus = useInboxStore((s) => s.setStatus);
  const setTags = useInboxStore((s) => s.setTags);
  const sendMessage = useInboxStore((s) => s.sendMessage);
  const messagesByConversation = useInboxStore((s) => s.messagesByConversation);
  const timelineByConversation = useInboxStore((s) => s.timelineByConversation);
  const loadConversations = useInboxStore((s) => s.loadConversations);
  const loadInboxSettings = useInboxStore((s) => s.loadInboxSettings);
  const inboxSettings = useInboxStore((s) => s.inboxSettings);
  const loadError = useInboxStore((s) => s.loadError);
  const sendError = useInboxStore((s) => s.sendError);
  const socketStatus = useInboxStore((s) => s.socketStatus);

  // A clock for "waiting 2h 04m" and the late folder, ticking once a minute so
  // a thread crosses the SLA line on screen without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    const stop = () => clearInterval(t);
    return stop;
  }, []);

  // A SELECTION THAT SURVIVED THE NARROWING. The chosen business is remembered
  // across visits; a staff member at a different business would otherwise land
  // on somebody else's tab and get a 403 rendered as "could not load".
  useEffect(() => {
    if (!known || businesses.length === 0) return;
    if (businesses.some((option) => option.slug === selectedOrg)) return;
    setSelectedOrg(businesses[0].slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [known, businesses, selectedOrg]);

  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [search, setSearch] = useState("");
  // A single label to narrow the list to, on top of the folder.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // A pipeline stage to narrow to — the "category" tabs of a DoubleTick inbox.
  const [stageFilter, setStageFilter] = useState<string | null>(null);
  // Which channel to narrow to.
  const [channelFilter, setChannelFilter] = useState<string | null>(null);
  // Which teammate's threads ("__none" = unassigned), and how recent.
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [dateRange, setDateRange] = useState<DateRange>("any");
  useEffect(() => {
    setTagFilter(null);
    setStageFilter(null);
    setChannelFilter(null);
    setOwnerFilter("");
    setSearch("");
  }, [selectedOrg]);

  useEffect(() => {
    loadConversations();
    loadInboxSettings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrg]);

  // BEST-EFFORT: pull this staff member's client email into the inbox as email
  // conversations when it opens. Idempotent server-side; a newly-stored message
  // triggers one reload. Only for staff — an operator has no mailbox.
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

  // ARRIVING FROM A LINK. The operators deck names a conversation ("Ahmed has
  // been waiting 3 hours"); ?business=&conversation= opens it. Applied ONCE, on
  // arrival — re-applying would drag a person back to the linked thread every
  // time they clicked another. `applied` is a ref so setting it cannot itself
  // cause the render that re-runs this.
  const params = useSearchParams();
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;

    const business = params.get("business");
    const conversation = params.get("conversation");
    if (!business && !conversation) return;

    applied.current = true;

    // The business first: setSelectedOrg clears the selected conversation and
    // the loaded list, so choosing a conversation before it would be undone.
    if (business && businesses.some((option) => option.slug === business)) {
      if (business !== selectedOrg) setSelectedOrg(business as typeof selectedOrg);
    }
    if (conversation) selectConversation(conversation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const activeConversation = conversations.find((c) => c.id === selectedConversationId);
  const messages = selectedConversationId ? messagesByConversation[selectedConversationId] ?? [] : [];
  const timeline = selectedConversationId ? timelineByConversation[selectedConversationId] ?? [] : [];
  const sla = inboxSettings.slaMinutes;

  // The folders offered, with a live count on each. An operator owns no
  // conversations personally, so "Mine" would always be empty — dropped.
  const folders = useMemo(() => {
    const all = folderList(sla);
    return myEmployeeId ? all : all.filter((f) => f.key !== "mine");
  }, [sla, myEmployeeId]);
  const counts = useMemo(() => {
    const out = {} as Record<FolderKey, number>;
    for (const f of folders) {
      out[f.key] = conversations.filter((c) => matchesFolder(c, f.key, myEmployeeId, sla, now)).length;
    }
    return out;
  }, [conversations, folders, myEmployeeId, sla, now]);

  // Every label in use across the loaded inbox — the vocabulary for the filter
  // chips and the editor's suggestions, sorted so it is stable to read.
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) for (const t of c.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  // The teammates who own threads here, for the owner filter.
  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of conversations) {
      if (c.assignedEmployeeId) map.set(c.assignedEmployeeId, c.assignedEmployeeName ?? "A colleague");
    }
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [conversations]);

  // The channel tabs: the four always offered, plus any other in use.
  const channelTabs = useMemo(() => {
    const tabs = [...CHANNEL_TABS] as string[];
    const present = new Set(conversations.map((c) => c.channel));
    for (const ch of present) if (!tabs.includes(ch)) tabs.push(ch);
    return tabs;
  }, [conversations]);

  // Everything EXCEPT the stage and channel filters — the pool the stage tabs and
  // channel tabs count against, so each badge shows what clicking it reveals.
  const needle = search.trim().toLowerCase();
  const rangeMs = DATE_RANGES.find((r) => r.key === dateRange)?.ms ?? 0;
  const baseFiltered = conversations.filter(
    (c) =>
      matchesFolder(c, folder, myEmployeeId, sla, now) &&
      (!tagFilter || c.tags.includes(tagFilter)) &&
      (!ownerFilter ||
        (ownerFilter === "__none" ? c.assignedEmployeeId == null : c.assignedEmployeeId === ownerFilter)) &&
      (!rangeMs || (c.lastMessageAt != null && now - new Date(c.lastMessageAt).getTime() <= rangeMs)) &&
      (!needle ||
        [c.contactName, c.contactWaId, c.lastMessagePreview, c.leadStage, ...c.tags]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)))
  );
  const stageCounts = baseFiltered.reduce<Record<string, number>>((acc, c) => {
    if (c.leadStage) acc[c.leadStage] = (acc[c.leadStage] ?? 0) + 1;
    return acc;
  }, {});
  // The business's stages in its own order, then any stage in use that is not on
  // its list (set before the list was customised) so nothing is unreachable.
  const stageTabs = useMemo(() => {
    const present = new Set(conversations.map((c) => c.leadStage).filter(Boolean) as string[]);
    return inboxSettings.stages.concat([...present].filter((s) => !inboxSettings.stages.includes(s)).sort());
  }, [conversations, inboxSettings.stages]);
  const showStageTabs = !inboxSettings.isDefault || conversations.some((c) => c.leadStage);

  const stageFiltered = baseFiltered.filter((c) => !stageFilter || c.leadStage === stageFilter);
  const channelCounts = stageFiltered.reduce<Record<string, number>>((acc, c) => {
    acc[c.channel] = (acc[c.channel] ?? 0) + 1;
    return acc;
  }, {});
  const visibleConversations = stageFiltered.filter((c) => !channelFilter || c.channel === channelFilter);

  // The open thread: messages and what-happened lines, merged by time, with a
  // separator at each new day.
  const threadRows = useMemo(() => {
    const merged: ThreadRow[] = [
      ...messages.map((m) => ({ kind: "msg" as const, key: `m-${m.id}`, at: m.createdAt, message: m })),
      ...timeline.map((i) => ({ kind: "item" as const, key: i.id, at: i.at, item: i })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const out: ThreadRow[] = [];
    let lastDay = "";
    for (const row of merged) {
      if (row.kind === "day") continue;
      const day = new Date(row.at).toDateString();
      if (day !== lastDay) {
        out.push({ kind: "day", key: `d-${day}`, label: dayLabel(row.at, now) });
        lastDay = day;
      }
      out.push(row);
    }
    return out;
  }, [messages, timeline, now]);

  // Keep the newest message in view as the thread fills or a new one arrives.
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [threadRows.length, selectedConversationId]);

  // SLASH COMMANDS: a draft that is a single "/word" line opens the quick replies.
  const slashQuery = draft.startsWith("/") && !draft.includes("\n") ? draft.slice(1) : null;

  async function handleSend() {
    if (!selectedConversationId || !draft.trim()) return;
    setIsSending(true);
    try {
      await sendMessage(selectedConversationId, draft.trim());
      setDraft("");
    } catch {
      // The store has already recorded why, and it is rendered beside the box.
      // The draft stays exactly where it was typed — the only copy of it.
    } finally {
      setIsSending(false);
    }
  }

  // AI Assist, in the compose box. Both fill the draft and never send.
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

  const contactLabel = (c: ConversationSummary): string =>
    c.contactName ?? (c.contactWaId ? `+${c.contactWaId}` : `${channelMeta(c.channel).label} customer`);

  const waitingMs =
    activeConversation?.lastMessageDirection === "inbound" && activeConversation.lastMessageAt
      ? now - new Date(activeConversation.lastMessageAt).getTime()
      : null;
  const isResolved = activeConversation?.status === "resolved" || activeConversation?.status === "closed";

  return (
    <div className="ibx">
      {/* Live feed down and retrying. Only for "closed" — "off" (no socket
          configured) and "connecting" are not faults to announce. */}
      {socketStatus === "closed" ? (
        <div className="ibx-offline" role="status" aria-live="polite">
          <span className="ibx-offline-dot" aria-hidden="true" />
          Live updates paused — reconnecting. New messages may be delayed.
        </div>
      ) : null}

      <aside className="ibx-col ibx-biz">
        <h2 className="ibx-head">Businesses</h2>
        <ul className="ibx-list">
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

        <input
          className="ibx-search"
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, number, message, label…"
          aria-label="Search conversations"
        />

        {/* Channel tabs — the primary axis. The folders below narrow WITHIN it. */}
        <div className="ibx-chantabs" role="tablist" aria-label="Channel">
          <button
            type="button"
            role="tab"
            aria-selected={channelFilter === null}
            className={`ibx-chantab${channelFilter === null ? " on" : ""}`}
            onClick={() => setChannelFilter(null)}
          >
            <span className="ibx-chantab-label">All</span>
            <span className="ibx-chantab-n">{stageFiltered.length}</span>
          </button>
          {channelTabs.map((ch) => (
            <button
              key={ch}
              type="button"
              role="tab"
              aria-selected={channelFilter === ch}
              className={`ibx-chantab${channelFilter === ch ? " on" : ""}`}
              onClick={() => setChannelFilter(ch)}
            >
              <span className="ibx-chantab-ic" aria-hidden="true">{channelMeta(ch).glyph}</span>
              <span className="ibx-chantab-label">{channelMeta(ch).label}</span>
              <span className="ibx-chantab-n">{channelCounts[ch] ?? 0}</span>
            </button>
          ))}
        </div>

        {/* Pipeline-stage tabs with counts — the business's own categories. */}
        {showStageTabs ? (
          <div className="ibx-stagetabs" role="tablist" aria-label="Pipeline stage">
            <button
              type="button"
              role="tab"
              aria-selected={stageFilter === null}
              className={`ibx-stagetab${stageFilter === null ? " on" : ""}`}
              onClick={() => setStageFilter(null)}
            >
              All stages <span className="ibx-stagetab-n">{baseFiltered.length}</span>
            </button>
            {stageTabs.map((s) => (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={stageFilter === s}
                className={`ibx-stagetab${stageFilter === s ? " on" : ""}${stageCounts[s] ? "" : " zero"}`}
                onClick={() => setStageFilter((cur) => (cur === s ? null : s))}
              >
                {s} <span className="ibx-stagetab-n">{stageCounts[s] ?? 0}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* The folders. Nothing until the role is known. */}
        {known ? (
          <div className="ibx-folders" role="tablist" aria-label="Filter conversations">
            {folders.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={folder === f.key}
                className={`ibx-folder${folder === f.key ? " on" : ""}${
                  (f.key === "late" || f.key === "followup" || f.key === "unread") && counts[f.key] > 0 ? " urgent" : ""
                }`}
                onClick={() => setFolder(f.key)}
              >
                {f.label}
                <span className="ibx-folder-n">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        ) : null}

        {/* Owner and date filters, plus labels. */}
        <div className="ibx-filters">
          <select
            className="ibx-filter-sel"
            value={ownerFilter}
            onChange={(e) => setOwnerFilter(e.target.value)}
            aria-label="Filter by team member"
          >
            <option value="">Anyone</option>
            <option value="__none">Unassigned</option>
            {owners.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            className="ibx-filter-sel"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as DateRange)}
            aria-label="Filter by last activity"
          >
            {DATE_RANGES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
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

        {isLoadingConversations && conversations.length === 0 ? (
          <p className="ibx-empty">Loading…</p>
        ) : loadError ? (
          /*
           * NOT "No conversations yet". A failed load used to render the empty
           * state, which on this screen reads as "nobody needs you".
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
              : needle
                ? `Nothing matches “${search.trim()}” here — try another folder or clear the search.`
                : channelFilter
                  ? `No ${channelMeta(channelFilter).label} conversations here yet — try another channel tab, or “All”.`
                  : folder === "mine"
                    ? "None of this business's conversations are yours yet. A customer who opens a chat through your link, or one handed to you, will appear here."
                    : folder === "unread"
                      ? "You're all caught up — nothing unread."
                      : folder === "late"
                        ? "Nobody has been left waiting past the reply-time target."
                        : folder === "followup"
                          ? "No follow-ups are overdue. Add one from a conversation's Follow-ups panel."
                          : "Nothing in this folder right now."}
          </p>
        ) : (
          <ul className="ibx-list">
            {visibleConversations.map((conversation) => {
              const late = isLate(conversation, sla, now);
              const unread = conversation.unreadCount ?? 0;
              return (
                <li key={conversation.id}>
                  <button
                    onClick={() => selectConversation(conversation.id)}
                    className={`ibx-convo${selectedConversationId === conversation.id ? " on" : ""}${
                      unread ? " unread" : ""
                    }`}
                    aria-current={selectedConversationId === conversation.id ? "true" : undefined}
                  >
                    <div className="ibx-convo-top">
                      {conversation.lastMessageDirection === "inbound" && (
                        <span
                          className={`ibx-await${late ? " late" : ""}`}
                          title={late ? "Past the reply-time target" : "Waiting on a reply"}
                          aria-hidden="true"
                        />
                      )}
                      <span
                        className="ibx-convo-chan"
                        title={channelMeta(conversation.channel).label}
                        aria-label={channelMeta(conversation.channel).label}
                      >
                        {channelMeta(conversation.channel).glyph}
                      </span>
                      <span className="ibx-convo-name">{contactLabel(conversation)}</span>
                      <span className="ibx-convo-time">{rowTime(conversation.lastMessageAt, now)}</span>
                    </div>
                    <div className="ibx-convo-mid">
                      <p className="ibx-preview">{conversation.lastMessagePreview ?? "No messages yet"}</p>
                      {unread ? (
                        <span className="ibx-unread" aria-label={`${unread} unread`}>
                          {unread > 99 ? "99+" : unread}
                        </span>
                      ) : null}
                    </div>
                    <div className="ibx-convo-meta">
                      {conversation.assignedEmployeeName ? (
                        <span className="ibx-row-owner" title="Assigned to">
                          👤 {conversation.assignedEmployeeName}
                        </span>
                      ) : null}
                      {conversation.isHumanHandoff && <span className="ibx-flag">human</span>}
                      {conversation.status === "resolved" || conversation.status === "closed" ? (
                        <span className="ibx-flag ibx-flag-done">resolved</span>
                      ) : null}
                      {conversation.hasOverdueFollowup && (
                        <span className="ibx-flag ibx-flag-due" title="Follow-up overdue">
                          ⏰ follow-up
                        </span>
                      )}
                      {conversation.leadStage ? <span className="ibx-row-stage">{conversation.leadStage}</span> : null}
                      {conversation.tags.slice(0, 3).map((t) => (
                        <span key={t} className="ibx-row-tag">
                          {t}
                        </span>
                      ))}
                      {conversation.tags.length > 3 ? (
                        <span className="ibx-row-tag ibx-row-tag-more">+{conversation.tags.length - 3}</span>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
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
                <h1 className="ibx-who">{contactLabel(activeConversation)}</h1>
                <p className="ibx-wa">
                  <span className="ibx-thread-chan" title={channelMeta(activeConversation.channel).label}>
                    {channelMeta(activeConversation.channel).glyph} {channelMeta(activeConversation.channel).label}
                  </span>
                  {activeConversation.contactWaId ? ` · +${activeConversation.contactWaId}` : ""}
                  {activeConversation.assignedEmployeeName
                    ? ` · assigned to ${activeConversation.assignedEmployeeName}`
                    : " · unassigned"}
                </p>
                <TagEditor
                  key={activeConversation.id}
                  tags={activeConversation.tags}
                  suggestions={allTags}
                  onChange={(next) => setTags(activeConversation.id, next)}
                />
              </div>
              <div className="ibx-handoff-block">
                {/* Resolve files the thread as done; a customer writing again
                    reopens it by itself, so nothing new can be swallowed. */}
                <button
                  type="button"
                  className={`ibx-resolve${isResolved ? " reopen" : ""}`}
                  onClick={() => void setStatus(activeConversation.id, isResolved ? "open" : "resolved")}
                >
                  {isResolved ? "↺ Reopen" : "✓ Resolve"}
                </button>
                {/* The checkbox shows one boolean; six things in the platform can
                    set it, and migration 062 records which. The history sits
                    directly under the control it explains. */}
                <label className="ibx-handoff">
                  Human handoff
                  <input
                    type="checkbox"
                    checked={activeConversation.isHumanHandoff}
                    onChange={(e) => void setHumanHandoff(activeConversation.id, e.target.checked)}
                  />
                </label>
                <ConversationCustody key={activeConversation.id} conversationId={activeConversation.id} />
              </div>
            </header>
            {/* Keyed on the conversation so switching customers resets it. */}
            <ConversationTasks key={activeConversation.id} conversationId={activeConversation.id} />
            <div className="ibx-msgs">
              {threadRows.map((row) =>
                row.kind === "day" ? (
                  <div key={row.key} className="ibx-day">
                    <span>{row.label}</span>
                  </div>
                ) : row.kind === "item" ? (
                  <div key={row.key} className={`ibx-event ${row.item.tone}`}>
                    <span>{row.item.text}</span>
                    <time>{clock(row.item.at)}</time>
                  </div>
                ) : (
                  <div
                    key={row.key}
                    className={`ibx-bubble ${row.message.direction === "inbound" ? "in" : "out"}${
                      row.message.senderType === "ai_agent" ? " ai" : ""
                    }`}
                  >
                    {row.message.direction === "outbound" ? (
                      <div className="ibx-bubble-who">
                        {row.message.senderType === "ai_agent" ? (
                          <span className="ibx-ai-badge">AI agent</span>
                        ) : row.message.senderType === "system" ? (
                          <span className="ibx-sys-badge">System</span>
                        ) : (
                          <span>{row.message.senderName ?? "Team"}</span>
                        )}
                      </div>
                    ) : null}
                    <div className="ibx-bubble-body">{row.message.body}</div>
                    <div className="ibx-bubble-meta">
                      <time>{clock(row.message.createdAt)}</time>
                      {row.message.direction === "outbound" ? <Ticks status={row.message.status} /> : null}
                    </div>
                  </div>
                )
              )}
              <div ref={bottomRef} />
            </div>
            {/* The customer is waiting — say for how long, and whether that is
                past the business's reply-time target. */}
            {waitingMs != null && !isResolved ? (
              <p className={`ibx-sla${waitingMs > sla * 60_000 ? " late" : ""}`} role="status">
                {waitingMs > sla * 60_000
                  ? `⚠ Response delayed — the customer has waited ${waitedFor(waitingMs)} (target ${slaLabel(sla)})`
                  : `Customer waiting ${waitedFor(waitingMs)}`}
              </p>
            ) : null}
            {sendError ? (
              /*
               * A SEND THAT FAILED SAID NOTHING AT ALL. Meta refusing a message
               * outside the 24-hour window is the common one, and it happens
               * precisely when a customer has been waiting.
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
                slashQuery={slashQuery}
                onReplace={(body) => setDraft(body)}
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
              {/* A TEXTAREA, not a one-line input — a line break in a quick reply,
                  an AI draft or an email answer used to be flattened away.
                  Enter sends; Shift+Enter starts a new line; "/" opens replies. */}
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && slashQuery === null) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                rows={Math.min(6, Math.max(1, draft.split("\n").length))}
                placeholder='Reply as a human agent… (Enter to send, Shift+Enter for a new line, "/" for quick replies)'
                className="ibx-input"
              />
              <button type="submit" disabled={isSending || !draft.trim()} className="ibx-send">
                Send
              </button>
            </form>
          </>
        )}
      </section>

      {/* The Details panel — Details / Calls / Notes. Always the fourth column so
          the grid does not reflow when a conversation is opened. */}
      <aside className="ibx-col ibx-details">
        <h2 className="ibx-head">Customer</h2>
        {activeConversation ? (
          <DetailsPanel key={activeConversation.id} conversationId={activeConversation.id} />
        ) : (
          <p className="dp-empty">Select a conversation to see its details.</p>
        )}
      </aside>
    </div>
  );
}
