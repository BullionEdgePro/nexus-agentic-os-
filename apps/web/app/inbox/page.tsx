"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { ConversationSummary, ConversationChannel, MessageDto, TimelineItem } from "@nexus/shared";
import { suggestReply, polishText, syncGmailInbox, readableError, attachmentUrl } from "@/lib/api";
import { useInboxStore } from "@/lib/store";
import { useVisibleBusinesses } from "@/lib/business-tabs";
import { useInboxSocket } from "@/lib/use-inbox-socket";
import { ConversationTasks } from "./conversation-tasks";
import { ConversationCustody } from "./conversation-custody";
import { TagEditor } from "./tag-editor";
import { DetailsPanel, type PanelTab } from "./details-panel";
import { ScheduledMessages } from "./scheduled-messages";
import { QuickReplies } from "./quick-replies";
import "./inbox.css";

// ============================================================
// The inbox, laid out the way a team inbox is read.
// ============================================================
//
// Four regions, left to right, under one strip:
//   the STAGE BAR   — the business's pipeline stages as tabs with counts;
//   the SIDEBAR     — folders ("who is waiting on me", "who has nobody") and
//                     the View filters (team member, label, channel, date);
//   the CHAT LIST   — one row per conversation, newest activity first;
//   the THREAD      — messages and what-happened lines on one timeline;
//   the CUSTOMER    — Details / Calls / Notes, follow-ups and custody.
//
// Each folder is a plain predicate over a conversation, applied client-side to
// the business's loaded list. The point of a folder is not to hide work but to
// let a person answer one question at a time.
//
// "Unread" is PER PERSON (migration 090): customer messages the viewer has not
// seen since they last opened the thread — not the customer's WhatsApp read
// receipt, which says nothing about whether anyone here saw it.

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

const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  whatsapp: "WhatsApp",
  email: "Email",
  sms: "SMS",
  instagram: "Instagram",
  phone: "Phone",
  facebook: "Facebook",
};

function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel as ConversationChannel] ?? channel;
}

// The channels a staff member answers, always offered in the channel filter.
// Any OTHER channel that has conversations (sms, phone) is appended so nothing
// is ever hidden behind "All channels".
const CHANNEL_TABS: ConversationChannel[] = ["whatsapp", "email", "facebook", "instagram"];

/** "2h 04m", "35m", "3d 2h" — how long a customer has been waiting. */
function waitedFor(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** The same wait, said as a sentence: "2 hours : 04 minutes". */
function waitedWords(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  const rest = mins % 60;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (days > 0) return `${unit(days, "day")} : ${unit(hours, "hour")}`;
  if (hours > 0) return `${unit(hours, "hour")} : ${String(rest).padStart(2, "0")} minutes`;
  return unit(rest, "minute");
}

/** The SLA as a person says it: "3h", "45m", "1d". */
function slaLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/** A row's time: the clock today, then "Yesterday", a weekday, a date. */
function rowTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now - 86400_000);
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  if (now - d.getTime() < 6 * 86400_000) return d.toLocaleDateString([], { weekday: "short" });
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

/** "Poonam QuickSell" → "PQ"; "+97150…" → "#". */
function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || /^\d/.test(words[0])) return "#";
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return `${first}${last}`.toUpperCase();
}

/** One of six soft tints, fixed per person so a face is recognisable across visits. */
function tintOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const tint = h % 6;
  return tint + 1;
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

/** The folders under "All chats" — the status of the thread. */
const STATUS_FOLDERS: { key: FolderKey; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "resolved", label: "Closed" },
  { key: "awaiting", label: "Awaiting reply" },
  { key: "unread", label: "Unread" },
  { key: "all", label: "All" },
];

/** The folders beside it — who the thread is waiting on. */
function queueFolders(slaMinutes: number): { key: FolderKey; label: string; icon: IconName; hint?: string }[] {
  return [
    { key: "mine", label: "My chats", icon: "person" },
    { key: "late", label: "SLA breached", icon: "timer", hint: `Waiting longer than the ${slaLabel(slaMinutes)} reply-time target` },
    { key: "followup", label: "Follow-up due", icon: "bell" },
    { key: "unassigned", label: "Unassigned", icon: "nobody" },
    { key: "human", label: "Human-held", icon: "hand" },
  ];
}

const FOLDER_TITLE: Record<FolderKey, string> = {
  mine: "My chats",
  all: "All chats",
  unread: "Unread",
  awaiting: "Awaiting reply",
  late: "SLA breached",
  followup: "Follow-up due",
  unassigned: "Unassigned",
  human: "Human-held",
  open: "Open chats",
  resolved: "Closed chats",
};

type DateRange = "any" | "today" | "7d" | "30d";
const DATE_RANGES: { key: DateRange; label: string; ms: number }[] = [
  { key: "any", label: "All", ms: 0 },
  { key: "today", label: "Last 24 hours", ms: 86400_000 },
  { key: "7d", label: "Last 7 days", ms: 7 * 86400_000 },
  { key: "30d", label: "Last 30 days", ms: 30 * 86400_000 },
];

/** The emoji a reply most often needs — one tap, no hunting. */
const EMOJI = [
  "😊", "🙂", "😄", "😁", "😉", "😍", "🥰", "🤩", "😎", "🤗",
  "🙏", "👍", "👌", "👏", "🙌", "💪", "🤝", "✌️", "👋", "🎉",
  "❤️", "💙", "🔥", "⭐", "✨", "✅", "☑️", "📦", "🚚", "🛍️",
  "📞", "📅", "⏰", "💬", "📍", "💳", "🎁", "😅", "🤔", "😢",
];

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

  // Which folder is open. A staff member lands on "My chats" the moment we know
  // who they are — the question they came to answer ("who is waiting for me?")
  // — and an operator, who owns no conversations personally, starts on "All".
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
  const closeConversation = useInboxStore((s) => s.closeConversation);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [oldestFirst, setOldestFirst] = useState(false);
  // "All chats" is a group that folds away, as in any team inbox.
  const [statusOpen, setStatusOpen] = useState(true);
  // The customer panel folds away too, giving the thread the room.
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [panelTab, setPanelTab] = useState<PanelTab>("details");
  // A call dialled from the header: which chat, and when, so the Calls tab can
  // open the log already timing it. Keyed to the chat so switching drops it.
  const [dialled, setDialled] = useState<{ conversationId: string; at: number } | null>(null);
  // Below 1100px the panel is a drawer over the thread — start it closed there,
  // or the first thing a tablet shows is the panel covering the conversation.
  useEffect(() => {
    if (window.matchMedia("(max-width: 1100px)").matches) setDetailsOpen(false);
  }, []);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  // A single label to narrow the list to, on top of the folder.
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  // A pipeline stage to narrow to — the stage bar across the top.
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
  // A linked chat waits here until this person's own list has loaded, and is
  // opened only if it is in that list (a notification tap, or a shared link,
  // must never open a chat the signed-in person cannot see).
  const pendingConversation = useRef<string | null>(null);

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
    if (conversation) pendingConversation.current = conversation;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    const pending = pendingConversation.current;
    if (!pending || isLoadingConversations) return;
    if (conversations.some((c) => c.id === pending)) {
      selectConversation(pending);
      pendingConversation.current = null;
    } else if (conversations.length > 0) {
      // The list is in and the chat is not in it: not this person's to open.
      pendingConversation.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, isLoadingConversations]);

  // On a phone an open chat is its own screen, so the system back gesture
  // must return to the list rather than leave the app.
  useEffect(() => {
    if (!selectedConversationId || !window.matchMedia("(max-width: 760px)").matches) return;
    history.pushState({ nexusThread: selectedConversationId }, "");
    const onPop = () => closeConversation();
    window.addEventListener("popstate", onPop);
    return function stopListeningForBack() {
      window.removeEventListener("popstate", onPop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedConversationId]);

  // The visible height, which shrinks when the phone keyboard opens, so the
  // composer stays on screen above it (iOS does not shrink 100dvh for that).
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const sync = () => document.documentElement.style.setProperty("--vvh", `${viewport.height}px`);
    sync();
    viewport.addEventListener("resize", sync);
    return function stopTrackingHeight() {
      viewport.removeEventListener("resize", sync);
    };
  }, []);

  const activeConversation = conversations.find((c) => c.id === selectedConversationId);
  const messages = selectedConversationId ? messagesByConversation[selectedConversationId] ?? [] : [];
  const timeline = selectedConversationId ? timelineByConversation[selectedConversationId] ?? [] : [];
  const sla = inboxSettings.slaMinutes;

  // The folders offered, with a live count on each. An operator owns no
  // conversations personally, so "My chats" would always be empty — dropped.
  const queues = useMemo(() => {
    const all = queueFolders(sla);
    return myEmployeeId ? all : all.filter((f) => f.key !== "mine");
  }, [sla, myEmployeeId]);
  const counts = useMemo(() => {
    const out = {} as Record<FolderKey, number>;
    for (const f of [...STATUS_FOLDERS, ...queues]) {
      out[f.key] = conversations.filter((c) => matchesFolder(c, f.key, myEmployeeId, sla, now)).length;
    }
    return out;
  }, [conversations, queues, myEmployeeId, sla, now]);

  // Every label in use across the loaded inbox — the vocabulary for the filter
  // and the editor's suggestions, sorted so it is stable to read.
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

  // The channel choices: the four always offered, plus any other in use.
  const channelTabs = useMemo(() => {
    const tabs = [...CHANNEL_TABS] as string[];
    const present = new Set(conversations.map((c) => c.channel));
    for (const ch of present) if (!tabs.includes(ch)) tabs.push(ch);
    return tabs;
  }, [conversations]);

  // Everything EXCEPT the stage and channel filters — the pool the stage bar and
  // the channel filter count against, so each number shows what choosing it reveals.
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

  const stageFiltered = baseFiltered.filter((c) => !stageFilter || c.leadStage === stageFilter);
  const channelCounts = stageFiltered.reduce<Record<string, number>>((acc, c) => {
    acc[c.channel] = (acc[c.channel] ?? 0) + 1;
    return acc;
  }, {});
  const filtered = stageFiltered.filter((c) => !channelFilter || c.channel === channelFilter);
  // Newest activity first, as served — or flipped, to work a backlog oldest-first.
  const visibleConversations = oldestFirst ? [...filtered].reverse() : filtered;

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

  // An emoji goes in where the caret is, not at the end of the draft.
  function insertEmoji(emoji: string) {
    const box = composerRef.current;
    const at = box ? box.selectionStart ?? draft.length : draft.length;
    const end = box ? box.selectionEnd ?? at : at;
    setDraft((d) => d.slice(0, at) + emoji + d.slice(end));
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      if (!box) return;
      box.focus();
      box.setSelectionRange(at + emoji.length, at + emoji.length);
    });
  }

  // The header's shortcuts into the customer panel.
  function openPanel(tab: PanelTab, focusId?: string) {
    setDetailsOpen(true);
    setPanelTab(tab);
    if (focusId) setTimeout(() => document.getElementById(focusId)?.focus(), 60);
  }

  const contactLabel = (c: ConversationSummary): string =>
    c.contactName ?? (c.contactWaId ? `+${c.contactWaId}` : `${channelLabel(c.channel)} customer`);

  const waitingMs =
    activeConversation?.lastMessageDirection === "inbound" && activeConversation.lastMessageAt
      ? now - new Date(activeConversation.lastMessageAt).getTime()
      : null;
  const isResolved = activeConversation?.status === "resolved" || activeConversation?.status === "closed";
  const businessName = businesses.find((b) => b.slug === selectedOrg)?.name ?? "";

  return (
    <div
      className={`ibx${detailsOpen ? "" : " no-details"}${activeConversation ? " has-thread" : ""}`}
    >
      {/* Live feed down and retrying. Only for "closed" — "off" (no socket
          configured) and "connecting" are not faults to announce. */}
      {socketStatus === "closed" ? (
        <div className="ibx-offline" role="status" aria-live="polite">
          <span className="ibx-offline-dot" aria-hidden="true" />
          Live updates paused — reconnecting. New messages may be delayed.
        </div>
      ) : null}

      {/* ---- the stage bar: the business's pipeline, with counts ---- */}
      <nav className="ibx-stagebar" aria-label="Pipeline stage">
        <div className="ibx-stagebar-track" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={stageFilter === null}
            className={`ibx-stage${stageFilter === null ? " on" : ""}`}
            onClick={() => setStageFilter(null)}
          >
            All
          </button>
          {stageTabs.map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={stageFilter === s}
              className={`ibx-stage${stageFilter === s ? " on" : ""}${stageCounts[s] ? "" : " zero"}`}
              onClick={() => setStageFilter((cur) => (cur === s ? null : s))}
            >
              {s} <span className="ibx-stage-n">{stageCounts[s] ?? 0}</span>
            </button>
          ))}
        </div>
        <span className={`ibx-live ${socketStatus}`} title={socketStatus === "open" ? "Live" : "Connecting"}>
          <span className="ibx-live-dot" aria-hidden="true" />
          {socketStatus === "open" ? "Live" : socketStatus === "closed" ? "Reconnecting" : "Connecting"}
        </span>
      </nav>

      {/* ---- the sidebar: business, folders, and the View filters ---- */}
      <aside className="ibx-side" aria-label="Folders">
        <div className="ibx-side-head">
          <h2 className="ibx-side-title">Inbox</h2>
          <button
            type="button"
            className="ibx-iconbtn"
            title={detailsOpen ? "Hide the customer panel" : "Show the customer panel"}
            aria-label={detailsOpen ? "Hide the customer panel" : "Show the customer panel"}
            onClick={() => setDetailsOpen((o) => !o)}
          >
            <Icon name="panel" />
          </button>
        </div>

        {known ? (
          businesses.length > 1 ? (
            <label className="ibx-biz">
              <span className="ibx-biz-k">Business</span>
              <select
                className="ibx-biz-sel"
                value={selectedOrg}
                onChange={(e) => setSelectedOrg(e.target.value as typeof selectedOrg)}
                aria-label="Business"
              >
                {businesses.map((option) => (
                  <option key={option.slug} value={option.slug}>
                    {option.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="ibx-biz-one">{businessName}</p>
          )
        ) : null}

        {/* The folders. Nothing until the role is known. */}
        {known ? (
          <div className="ibx-folders" role="tablist" aria-label="Filter conversations">
            <button
              type="button"
              className={`ibx-group${statusOpen ? " open" : ""}`}
              aria-expanded={statusOpen}
              onClick={() => setStatusOpen((o) => !o)}
            >
              <Icon name="inbox" />
              <span>All chats</span>
              <Icon name="chevron" className="ibx-group-chev" />
            </button>
            {statusOpen ? (
              <div className="ibx-subfolders">
                {STATUS_FOLDERS.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    role="tab"
                    aria-selected={folder === f.key}
                    className={`ibx-folder sub${folder === f.key ? " on" : ""}`}
                    onClick={() => setFolder(f.key)}
                  >
                    <span className="ibx-folder-label">{f.label}</span>
                    <span className={`ibx-folder-n${f.key === "unread" && counts[f.key] > 0 ? " hot" : ""}`}>
                      {counts[f.key] > 999 ? "1K+" : counts[f.key]}
                    </span>
                    {f.key === "awaiting" && counts[f.key] > 0 ? (
                      <Icon name="timer" className="ibx-folder-warn" />
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
            {queues.map((f) => (
              <button
                key={f.key}
                type="button"
                role="tab"
                aria-selected={folder === f.key}
                className={`ibx-folder${folder === f.key ? " on" : ""}${
                  (f.key === "late" || f.key === "followup") && counts[f.key] > 0 ? " urgent" : ""
                }`}
                onClick={() => setFolder(f.key)}
                title={f.hint}
              >
                <Icon name={f.icon} />
                <span className="ibx-folder-label">{f.label}</span>
                <span className="ibx-folder-n">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        ) : null}

        <h3 className="ibx-side-h">View</h3>
        <div className="ibx-filters">
          <label className="ibx-filter">
            <span>Team member</span>
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
          </label>
          <label className="ibx-filter">
            <span>Tags</span>
            <select
              className="ibx-filter-sel"
              value={tagFilter ?? ""}
              onChange={(e) => setTagFilter(e.target.value || null)}
              aria-label="Filter by label"
            >
              <option value="">{allTags.length ? "Any label" : "No labels yet"}</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="ibx-filter">
            <span>Channels</span>
            <select
              className="ibx-filter-sel"
              value={channelFilter ?? ""}
              onChange={(e) => setChannelFilter(e.target.value || null)}
              aria-label="Filter by channel"
            >
              <option value="">All channels ({stageFiltered.length})</option>
              {channelTabs.map((ch) => (
                <option key={ch} value={ch}>
                  {channelLabel(ch)} ({channelCounts[ch] ?? 0})
                </option>
              ))}
            </select>
          </label>
          <label className="ibx-filter">
            <span>Date range</span>
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
          </label>
        </div>
      </aside>

      {/* ---- the chat list ---- */}
      <section className="ibx-listcol" aria-label="Conversations">
        <header className="ibx-list-head">
          <h2 className="ibx-list-title">
            {FOLDER_TITLE[folder]}
            <span className="ibx-list-count">{visibleConversations.length}</span>
          </h2>
          <button
            type="button"
            className={`ibx-iconbtn${searchOpen ? " on" : ""}`}
            title="Search"
            aria-label="Search conversations"
            aria-pressed={searchOpen}
            onClick={() => {
              setSearchOpen((o) => !o);
              if (searchOpen) setSearch("");
            }}
          >
            <Icon name="search" />
          </button>
          <button
            type="button"
            className={`ibx-iconbtn${oldestFirst ? " on" : ""}`}
            title={oldestFirst ? "Oldest first — show newest first" : "Newest first — show oldest first"}
            aria-label="Change sort order"
            aria-pressed={oldestFirst}
            onClick={() => setOldestFirst((o) => !o)}
          >
            <Icon name="sort" />
          </button>
        </header>

        {searchOpen ? (
          <input
            className="ibx-search"
            type="search"
            value={search}
            autoFocus
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, number, message, label…"
            aria-label="Search conversations"
          />
        ) : null}

        {tagFilter || channelFilter || ownerFilter || stageFilter || dateRange !== "any" ? (
          <div className="ibx-active-filters">
            {stageFilter ? <FilterChip label={stageFilter} onClear={() => setStageFilter(null)} /> : null}
            {tagFilter ? <FilterChip label={`# ${tagFilter}`} onClear={() => setTagFilter(null)} /> : null}
            {channelFilter ? (
              <FilterChip label={channelLabel(channelFilter)} onClear={() => setChannelFilter(null)} />
            ) : null}
            {ownerFilter ? (
              <FilterChip
                label={ownerFilter === "__none" ? "Unassigned" : owners.find(([id]) => id === ownerFilter)?.[1] ?? "Member"}
                onClear={() => setOwnerFilter("")}
              />
            ) : null}
            {dateRange !== "any" ? (
              <FilterChip
                label={DATE_RANGES.find((r) => r.key === dateRange)?.label ?? ""}
                onClear={() => setDateRange("any")}
              />
            ) : null}
          </div>
        ) : null}

        <div className="ibx-list-scroll">
          {isLoadingConversations && conversations.length === 0 ? (
            <div className="ibx-skeleton" aria-label="Loading conversations">
              {[0, 1, 2, 3, 4].map((i) => (
                <div key={i} className="ibx-skel-row">
                  <span className="ibx-skel-av" />
                  <span className="ibx-skel-lines">
                    <span className="nx-skel" style={{ width: "55%" }} />
                    <span className="nx-skel" style={{ width: "85%" }} />
                  </span>
                </div>
              ))}
            </div>
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
            <div className="ibx-empty-state">
              <EmptyArt />
              <p className="ibx-empty">
                {conversations.length === 0
                  ? "No conversations yet for this business."
                  : needle
                    ? `Nothing matches “${search.trim()}” here — try another folder or clear the search.`
                    : channelFilter
                      ? `No ${channelLabel(channelFilter)} conversations here yet — try another channel, or all channels.`
                      : folder === "mine"
                        ? "None of this business's conversations are yours yet. A customer who opens a chat through your link, or one handed to you, will appear here."
                        : folder === "unread"
                          ? "You're all caught up — nothing unread."
                          : folder === "late"
                            ? "Nobody has been left waiting past the reply-time target."
                            : folder === "followup"
                              ? "No follow-ups are overdue. Add one from a conversation's customer panel."
                              : "Nothing in this folder right now."}
              </p>
            </div>
          ) : (
            <ul className="ibx-list">
              {visibleConversations.map((conversation) => {
                const late = isLate(conversation, sla, now);
                const unread = conversation.unreadCount ?? 0;
                const name = contactLabel(conversation);
                return (
                  <li key={conversation.id}>
                    <button
                      onClick={() => selectConversation(conversation.id)}
                      className={`ibx-convo${selectedConversationId === conversation.id ? " on" : ""}${
                        unread ? " unread" : ""
                      }`}
                      aria-current={selectedConversationId === conversation.id ? "true" : undefined}
                    >
                      <Avatar name={name} channel={conversation.channel} />
                      <span className="ibx-convo-body">
                        <span className="ibx-convo-top">
                          <span className="ibx-convo-name">{name}</span>
                          {late ? (
                            <span className="ibx-convo-late" title="Past the reply-time target">
                              <Icon name="timer" />
                            </span>
                          ) : null}
                          {unread ? (
                            <span className="ibx-unread" aria-label={`${unread} unread`}>
                              {unread > 99 ? "99+" : unread}
                            </span>
                          ) : null}
                        </span>
                        <span className="ibx-convo-sub">
                          <Icon name="broadcast" />
                          <span>
                            {conversation.assignedEmployeeName
                              ? conversation.assignedEmployeeName
                              : `Unassigned · ${channelLabel(conversation.channel)}`}
                          </span>
                        </span>
                        <span className="ibx-convo-mid">
                          {conversation.lastMessageDirection === "outbound" ? (
                            <span className="ibx-convo-ticks" aria-hidden="true">✓✓</span>
                          ) : null}
                          <span className="ibx-preview">{conversation.lastMessagePreview ?? "No messages yet"}</span>
                          <span className="ibx-convo-time">{rowTime(conversation.lastMessageAt, now)}</span>
                        </span>
                        {conversation.isHumanHandoff ||
                        isResolvedStatus(conversation) ||
                        conversation.hasOverdueFollowup ||
                        conversation.leadStage ||
                        conversation.tags.length ? (
                          <span className="ibx-convo-meta">
                            {conversation.leadStage ? (
                              <span className="ibx-row-stage">{conversation.leadStage}</span>
                            ) : null}
                            {conversation.tags.slice(0, 2).map((t) => (
                              <span key={t} className="ibx-row-tag">
                                {t}
                              </span>
                            ))}
                            {conversation.tags.length > 2 ? (
                              <span className="ibx-row-tag ibx-row-tag-more">+{conversation.tags.length - 2}</span>
                            ) : null}
                            {conversation.isHumanHandoff && <span className="ibx-flag">Human</span>}
                            {isResolvedStatus(conversation) ? (
                              <span className="ibx-flag ibx-flag-done">Closed</span>
                            ) : null}
                            {conversation.hasOverdueFollowup && (
                              <span className="ibx-flag ibx-flag-due" title="Follow-up overdue">
                                Follow-up
                              </span>
                            )}
                          </span>
                        ) : null}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* ---- the thread ---- */}
      <section className="ibx-thread" aria-label="Conversation">
        {!activeConversation ? (
          <div className="ibx-thread-empty">
            <WelcomeArt />
            <h2>Pick a conversation</h2>
            <p>
              Every customer message lands here — WhatsApp, email, Facebook and Instagram — with the
              AI&apos;s replies, your team&apos;s, and everything that happened in between.
            </p>
          </div>
        ) : (
          <>
            <header className="ibx-thread-head">
              <button
                type="button"
                className="ibx-iconbtn ibx-back"
                aria-label="Back to the list"
                onClick={() => (history.state?.nexusThread ? history.back() : closeConversation())}
              >
                <Icon name="back" />
              </button>
              <Avatar name={contactLabel(activeConversation)} channel={activeConversation.channel} size="lg" />
              <div className="ibx-who-block">
                <h1 className="ibx-who">{contactLabel(activeConversation)}</h1>
                <p className="ibx-wa">
                  {channelLabel(activeConversation.channel)}
                  {activeConversation.contactWaId ? ` · +${activeConversation.contactWaId}` : ""}
                </p>
              </div>
              <div className="ibx-head-actions">
                <button
                  type="button"
                  className={`ibx-iconbtn${detailsOpen ? " on" : ""}`}
                  title={detailsOpen ? "Hide customer details" : "Customer details"}
                  aria-label={detailsOpen ? "Hide customer details" : "Show customer details"}
                  aria-pressed={detailsOpen}
                  onClick={() => setDetailsOpen((o) => !o)}
                >
                  <Icon name="panel" />
                </button>
                {/* WhatsApp chats have a number to dial: the header dials it (the
                    phone's dialer, or Phone Link on a computer) and opens the
                    Calls tab already timing the call. Other channels log only. */}
                {activeConversation.channel === "whatsapp" && activeConversation.contactWaId ? (
                  <a
                    className="ibx-callbtn"
                    href={`tel:+${activeConversation.contactWaId}`}
                    title={`Call +${activeConversation.contactWaId}`}
                    aria-label={`Call +${activeConversation.contactWaId}`}
                    onClick={() => {
                      setDialled({ conversationId: activeConversation.id, at: Date.now() });
                      openPanel("calls");
                    }}
                  >
                    <Icon name="phone" />
                    <span>Call</span>
                  </a>
                ) : (
                  <button
                    type="button"
                    className="ibx-iconbtn"
                    title="Log a call"
                    aria-label="Log a call"
                    onClick={() => openPanel("calls")}
                  >
                    <Icon name="phone" />
                  </button>
                )}
                <button
                  type="button"
                  className="ibx-assignee"
                  title="Assign this conversation"
                  onClick={() => openPanel("details", "dp-assign")}
                >
                  {activeConversation.assignedEmployeeName ? (
                    <span className="ibx-assignee-av">{initials(activeConversation.assignedEmployeeName)}</span>
                  ) : (
                    <Icon name="nobody" />
                  )}
                  <span className="ibx-assignee-name">
                    {activeConversation.assignedEmployeeName ?? "Assign"}
                  </span>
                  <Icon name="chevron" />
                </button>
                {/* Resolve files the thread as done; a customer writing again
                    reopens it by itself, so nothing new can be swallowed. */}
                <button
                  type="button"
                  className={`ibx-resolve${isResolved ? " reopen" : ""}`}
                  onClick={() => void setStatus(activeConversation.id, isResolved ? "open" : "resolved")}
                  title={isResolved ? "Reopen this conversation" : "Mark this conversation resolved"}
                >
                  <Icon name={isResolved ? "reopen" : "check"} />
                  <span>{isResolved ? "Reopen" : "Resolve"}</span>
                </button>
                {/* The switch shows one boolean; six things in the platform can
                    set it, and migration 062 records which — "Who has had this?"
                    in the customer panel reads that history. */}
                <label className="ibx-handoff" title="While on, the AI stays quiet and a person answers">
                  <input
                    type="checkbox"
                    checked={activeConversation.isHumanHandoff}
                    onChange={(e) => void setHumanHandoff(activeConversation.id, e.target.checked)}
                  />
                  <span className="ibx-switch" aria-hidden="true" />
                  <span className="ibx-handoff-label">
                    {activeConversation.isHumanHandoff ? "Human" : "AI on"}
                  </span>
                </label>
              </div>
            </header>
            <div className="ibx-thread-tags">
              <TagEditor
                key={activeConversation.id}
                tags={activeConversation.tags}
                suggestions={allTags}
                onChange={(next) => setTags(activeConversation.id, next)}
              />
            </div>

            <div className="ibx-msgs">
              {threadRows.map((row) =>
                row.kind === "day" ? (
                  <div key={row.key} className="ibx-day">
                    <span>{row.label}</span>
                  </div>
                ) : row.kind === "item" ? (
                  <div key={row.key} className={`ibx-event ${row.item.tone}`}>
                    <Icon name={row.item.kind === "call" ? "phone" : row.item.kind === "custody" ? "hand" : "spark"} />
                    <span>{row.item.text}</span>
                    <time>{clock(row.item.at)}</time>
                  </div>
                ) : (
                  <div
                    key={row.key}
                    className={`ibx-bubble ${row.message.direction === "inbound" ? "in" : "out"}${
                      row.message.senderType === "ai_agent" ? " ai" : ""
                    }${row.message.senderType === "system" ? " sys" : ""}`}
                  >
                    {row.message.direction === "outbound" ? (
                      <div className="ibx-bubble-who">
                        {row.message.senderType === "ai_agent" ? (
                          <span className="ibx-ai-badge">
                            <Icon name="spark" /> AI agent
                          </span>
                        ) : row.message.senderType === "system" ? (
                          <span className="ibx-sys-badge">System</span>
                        ) : (
                          <span>{row.message.senderName ?? "Team"}</span>
                        )}
                      </div>
                    ) : null}
                    {row.message.attachment ? <Attachment message={row.message} /> : null}
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
                <Icon name="timer" />
                {waitingMs > sla * 60_000
                  ? `Response delayed by ${waitedWords(waitingMs)} (target ${slaLabel(sla)})`
                  : `Customer waiting ${waitedFor(waitingMs)}`}
              </p>
            ) : null}

            <div className="ibx-compose-wrap">
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
                <div className="ibx-emoji">
                  <button
                    type="button"
                    className="ibx-iconbtn"
                    aria-label="Insert an emoji"
                    aria-expanded={emojiOpen}
                    onClick={() => setEmojiOpen((o) => !o)}
                  >
                    <Icon name="smile" />
                  </button>
                  {emojiOpen ? (
                    <div className="ibx-emoji-panel" role="menu">
                      {EMOJI.map((e) => (
                        <button key={e} type="button" className="ibx-emoji-pick" onClick={() => insertEmoji(e)}>
                          {e}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                {/* A TEXTAREA, not a one-line input — a line break in a quick reply,
                    an AI draft or an email answer used to be flattened away.
                    Enter sends; Shift+Enter starts a new line; "/" opens replies. */}
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && slashQuery === null) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  rows={Math.min(6, Math.max(1, draft.split("\n").length))}
                  placeholder='Type message or use "/" for quick replies'
                  className="ibx-input"
                />
                <button
                  type="button"
                  className={`ibx-iconbtn ibx-magic${ai === "suggest" ? " busy" : ""}`}
                  onClick={handleSuggest}
                  disabled={!!ai}
                  title="Suggest a reply from the conversation so far"
                  aria-label="Suggest a reply"
                >
                  <Icon name="magic" />
                </button>
                <button type="submit" disabled={isSending || !draft.trim()} className="ibx-send" aria-label="Send">
                  <Icon name="send" />
                </button>
              </form>

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
                <span className="ibx-compose-hint">Enter to send · Shift+Enter for a new line</span>
              </div>
            </div>
          </>
        )}
      </section>

      {/* ---- the customer panel: Details / Calls / Notes, then follow-ups and
          custody. Folds away from the sidebar's panel button. ---- */}
      <aside className="ibx-details" aria-label="Customer">
        {activeConversation ? (
          <>
            <DetailsPanel
              key={activeConversation.id}
              conversationId={activeConversation.id}
              tab={panelTab}
              onTabChange={setPanelTab}
              callStartedAt={dialled?.conversationId === activeConversation.id ? dialled.at : null}
            />
            {panelTab === "details" ? (
              <div className="ibx-side-cards">
                {/* Keyed on the conversation so switching customers resets it. */}
                <ConversationTasks key={activeConversation.id} conversationId={activeConversation.id} />
                <div className="ibx-card">
                  <h4 className="dp-h">History</h4>
                  <ConversationCustody key={activeConversation.id} conversationId={activeConversation.id} />
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="dp-empty">
            <WelcomeArt small />
            <p>Select a conversation to see who the customer is, what was promised, and what is due.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

function isResolvedStatus(c: ConversationSummary): boolean {
  return c.status === "resolved" || c.status === "closed";
}

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

function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button type="button" className="ibx-fchip" onClick={onClear} title="Clear this filter">
      {label}
      <span aria-hidden="true">×</span>
    </button>
  );
}

/** A face for a customer: initials on a fixed soft tint, the channel as a badge. */
function Avatar({ name, channel, size }: { name: string; channel: string; size?: "lg" }) {
  return (
    <span className={`ibx-av t${tintOf(name)}${size === "lg" ? " lg" : ""}`} aria-hidden="true">
      {initials(name)}
      <span className={`ibx-av-chan ch-${channel}`}>
        <ChannelGlyph channel={channel} />
      </span>
    </span>
  );
}

function ChannelGlyph({ channel }: { channel: string }) {
  switch (channel) {
    case "whatsapp":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.1c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .1-3.3-.8-2.8-1.1-4.5-3.9-4.7-4.1-.1-.2-1.1-1.5-1.1-2.8 0-1.3.7-2 1-2.3.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.4 0 .5l-.3.5-.4.4c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.1 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1c.2-.3.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.7-.1 1.2Z" />
        </svg>
      );
    case "instagram":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <rect x="4" y="4" width="16" height="16" rx="5" />
          <circle cx="12" cy="12" r="3.6" />
          <circle cx="17" cy="7" r="0.6" fill="currentColor" />
        </svg>
      );
    case "facebook":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M14 8h2.5V4.5H14c-2.5 0-4 1.6-4 4V11H7.5v3.5H10V21h3.5v-6.5H16l.5-3.5h-3V8.8c0-.5.3-.8.5-.8Z" />
        </svg>
      );
    case "email":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
          <path d="m4 7 8 6 8-6" />
        </svg>
      );
    case "phone":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M6.6 10.8a15 15 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2Z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 4h16v12H7l-3 3V4Z" />
        </svg>
      );
  }
}

type IconName =
  | "inbox"
  | "chevron"
  | "person"
  | "timer"
  | "bell"
  | "nobody"
  | "hand"
  | "search"
  | "sort"
  | "panel"
  | "broadcast"
  | "phone"
  | "check"
  | "reopen"
  | "spark"
  | "smile"
  | "magic"
  | "send"
  | "back";

const ICON_PATHS: Record<IconName, string> = {
  inbox: "M4 13h4l1.5 3h5L16 13h4M5.5 5h13L21 13v6H3v-6l2.5-8Z",
  chevron: "m6 9 6 6 6-6",
  person: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0",
  timer: "M12 8v5l3 2M9 2h6M12 22a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4l2-2Zm4 4h4",
  nobody: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 11.5-5.4M3 3l18 18",
  hand: "M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-7.5a1.5 1.5 0 0 1 3 0V12m0-5.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-4.8-2.4L3.6 15a1.5 1.5 0 0 1 2.3-1.9L8 15",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-3.5-3.5",
  sort: "M7 4v16m0 0-3-3m3 3 3-3M17 20V4m0 0-3 3m3-3 3 3",
  panel: "M4 4h16v16H4V4Zm11 0v16",
  broadcast: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm-3.5 2.5a5 5 0 0 1 0-7m7 0a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8m12.8 0a9 9 0 0 1 0 12.8",
  phone: "M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z",
  check: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-4-10 3 3 5-6",
  reopen: "M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4",
  spark: "M12 3v4m0 10v4M3 12h4m10 0h4M6 6l2.5 2.5m7 7L18 18M6 18l2.5-2.5m7-7L18 6",
  smile: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm-4-8a5 5 0 0 0 8 0M9 9.5h.01M15 9.5h.01",
  magic: "m4 20 10-10m2-6 .8 2.2L19 7l-2.2.8L16 10l-.8-2.2L13 7l2.2-.8L16 4ZM7 3l.5 1.5L9 5l-1.5.5L7 7l-.5-1.5L5 5l1.5-.5L7 3Zm12 10 .5 1.5L21 15l-1.5.5L19 17l-.5-1.5L17 15l1.5-.5L19 13Z",
  send: "M4 12 20 4l-6 16-3-7-7-1Z",
  back: "m15 18-6-6 6-6",
};

function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={`ibx-ic${className ? ` ${className}` : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}

/** Two chat bubbles floating over a sky disc — the empty thread, drawn. */
function WelcomeArt({ small }: { small?: boolean }) {
  return (
    <svg className={`ibx-art${small ? " small" : ""}`} viewBox="0 0 200 150" aria-hidden="true">
      <defs>
        <linearGradient id="ibx-art-sky" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--sky)" stopOpacity=".35" />
          <stop offset="1" stopColor="var(--signal)" stopOpacity=".12" />
        </linearGradient>
      </defs>
      <circle cx="100" cy="78" r="62" fill="url(#ibx-art-sky)" />
      <g className="ibx-art-b1">
        <rect x="34" y="38" width="92" height="40" rx="14" fill="var(--paper)" stroke="var(--hairline-strong)" />
        <rect x="46" y="51" width="52" height="6" rx="3" fill="var(--pebble)" />
        <rect x="46" y="62" width="34" height="6" rx="3" fill="var(--pebble)" />
      </g>
      <g className="ibx-art-b2">
        <rect x="80" y="86" width="88" height="38" rx="14" fill="var(--sky-soft)" stroke="var(--sky)" />
        <rect x="92" y="98" width="50" height="6" rx="3" fill="var(--paper)" />
        <rect x="92" y="109" width="30" height="6" rx="3" fill="var(--paper)" />
        <path d="M150 112l3 3 6-7" stroke="var(--sky-deep)" strokeWidth="2.2" fill="none" strokeLinecap="round" />
      </g>
      <circle className="ibx-art-dot" cx="160" cy="44" r="5" fill="var(--sky)" />
      <circle className="ibx-art-dot d2" cx="42" cy="112" r="3.5" fill="var(--sky-deep)" />
    </svg>
  );
}

function EmptyArt() {
  return (
    <svg className="ibx-art small" viewBox="0 0 120 90" aria-hidden="true">
      <circle cx="60" cy="46" r="36" fill="var(--sky-soft)" />
      <path d="M38 40h44l6 14v16H32V54l6-14Z" fill="var(--paper)" stroke="var(--hairline-strong)" />
      <path d="M32 54h16l4 6h16l4-6h16" fill="none" stroke="var(--sky-deep)" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The file a customer sent, inside their bubble: a photo or sticker shown, a
 * voice note or video playable, a document one click away. The label above the
 * text ("[Photo]", "[Voice note]") stays — it is what the AI and the chat list
 * read — and this is the thing itself. WhatsApp keeps files for about 30 days;
 * an older one fails to load and says so instead of showing a broken image.
 */
function Attachment({ message }: { message: MessageDto }) {
  const [failed, setFailed] = useState(false);
  const a = message.attachment;
  if (!a) return null;
  const src = attachmentUrl(message.conversationId, message.id);
  if (failed) {
    return <div className="ibx-att ibx-att-gone">This file has expired on WhatsApp (they keep files about 30 days).</div>;
  }
  if (a.kind === "image" || a.kind === "sticker") {
    return (
      <a className={`ibx-att ibx-att-img${a.kind === "sticker" ? " sticker" : ""}`} href={src} target="_blank" rel="noreferrer">
        <img src={src} alt={a.kind === "sticker" ? "Sticker from the customer" : "Photo from the customer"} loading="lazy" onError={() => setFailed(true)} />
      </a>
    );
  }
  if (a.kind === "audio") {
    return <audio className="ibx-att ibx-att-audio" controls preload="none" src={src} onError={() => setFailed(true)} />;
  }
  if (a.kind === "video") {
    return <video className="ibx-att ibx-att-video" controls preload="metadata" src={src} onError={() => setFailed(true)} />;
  }
  return (
    <a className="ibx-att ibx-att-doc" href={src} target="_blank" rel="noreferrer">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z" />
        <path d="M14 3v5h5" />
      </svg>
      <span>{a.filename ?? "Open document"}</span>
    </a>
  );
}
