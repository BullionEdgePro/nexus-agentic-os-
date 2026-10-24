"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { BusinessTabs, useVisibleBusinesses } from "@/lib/business-tabs";
import {
  getTeamMessages,
  getTeamThreads,
  markTeamThreadRead,
  openDirectChat,
  readableError,
  removeTeamChatMessage,
  sendTeamMessage,
  type TeamChatMessage,
  type TeamColleague,
  type TeamThreadSummary,
  type TeamThreadsResponse,
} from "@/lib/api";
import { useTeamSocket, type TeamSocketEvent } from "@/lib/use-team-socket";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../activity/activity.css";
import "./team-chat.css";

/**
 * Team chat — staff of one business talking to each other (24 Oct 2026).
 *
 * The team room first, then each colleague; one thread open at a time. The
 * admin picks a business, reads everything, and writes only in the room.
 * Spec: docs/superpowers/specs/2026-10-24-team-chat-design.md
 *
 * RELIABILITY, in the order a person would notice its absence:
 *   - a message is shown at once as "Sending…", and becomes "Not sent · Retry"
 *     if the server never confirms it; a retry reuses its id, so the server
 *     keeps it once however many times it arrives;
 *   - when the live connection comes back, the open thread and the list are
 *     read again, so nothing said while offline is missed;
 *   - with no live connection at all, both are read every 15 seconds.
 */

interface Pending {
  clientId: string;
  threadId: string;
  body: string;
  mentions: string[];
  status: "sending" | "failed";
}

const PAGE_SIZE = 50;

export default function TeamChatPage() {
  const { isOperator, known } = useVisibleBusinesses();
  const [business, setBusiness] = useState<BusinessSlug | "">("");
  const [data, setData] = useState<TeamThreadsResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<TeamChatMessage[]>([]);
  const [canPost, setCanPost] = useState(false);
  const [seenByOther, setSeenByOther] = useState<string | null>(null);
  const [threadError, setThreadError] = useState("");
  const [hasEarlier, setHasEarlier] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [draft, setDraft] = useState("");
  const [mentionIds, setMentionIds] = useState<Record<string, string>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const listEnd = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  // The admin chooses a business; staff have exactly one.
  useEffect(() => {
    if (known && isOperator && !business) setBusiness("zipicka");
  }, [known, isOperator, business]);
  const businessParam = isOperator ? business || null : null;
  const ready = known && (!isOperator || !!business);

  const loadThreads = useCallback(async () => {
    if (!ready) return;
    try {
      const next = await getTeamThreads(businessParam ?? undefined);
      setData(next);
      setLoadError("");
    } catch (err) {
      setLoadError(readableError(err, "Team chat could not be loaded."));
    }
  }, [ready, businessParam]);

  const loadMessages = useCallback(async (threadId: string) => {
    try {
      const page = await getTeamMessages(threadId);
      if (activeRef.current !== threadId) return;
      setMessages(page.messages);
      setCanPost(page.canPost);
      setSeenByOther(page.seenByOther);
      setHasEarlier(page.messages.length >= PAGE_SIZE);
      setThreadError("");
      void markTeamThreadRead(threadId)
        .then(() => window.dispatchEvent(new Event("nexus:team-unread")))
        .catch(() => undefined);
    } catch (err) {
      if (activeRef.current === threadId) setThreadError(readableError(err, "This chat could not be loaded."));
    }
  }, []);

  useEffect(() => {
    setActiveId(null);
    setMessages([]);
    void loadThreads();
  }, [loadThreads]);

  // Open the room on arrival, so the first screen is a conversation — once per
  // business, so "Back" on a phone stays on the list.
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!data?.threads[0] || autoOpened.current === data.business.slug) return;
    autoOpened.current = data.business.slug;
    if (!activeId && window.matchMedia("(min-width: 760px)").matches) setActiveId(data.threads[0].id);
  }, [data, activeId]);

  useEffect(() => {
    if (!activeId) return;
    setMessages([]);
    setPending((list) => list.filter((p) => p.status === "failed" || p.threadId === activeId));
    void loadMessages(activeId);
  }, [activeId, loadMessages]);

  // ---- live -------------------------------------------------------------
  const onEvent = useCallback(
    (event: TeamSocketEvent) => {
      if (event.type === "team_message" && event.message) {
        const incoming = event.message;
        if (event.threadId === activeRef.current) {
          setMessages((list) => (list.some((m) => m.id === incoming.id) ? list : [...list, incoming]));
          setPending((list) => list.filter((p) => p.clientId !== incoming.clientId));
          if (incoming.authorEmployeeId !== data?.me.employeeId) {
            void markTeamThreadRead(event.threadId)
              .then(() => window.dispatchEvent(new Event("nexus:team-unread")))
              .catch(() => undefined);
          }
        }
        void loadThreads();
      } else if (event.type === "team_message_removed" && event.message) {
        const removed = event.message;
        setMessages((list) => list.map((m) => (m.id === removed.id ? { ...m, ...removed, share: null } : m)));
        void loadThreads();
      } else if (event.type === "team_read" && event.threadId === activeRef.current) {
        if (event.reader && event.reader !== data?.me.employeeId && !event.reader.startsWith("admin:")) {
          setSeenByOther(new Date().toISOString());
        }
      }
    },
    [data?.me.employeeId, loadThreads]
  );
  const onReconnect = useCallback(() => {
    void loadThreads();
    if (activeRef.current) void loadMessages(activeRef.current);
  }, [loadThreads, loadMessages]);
  const socket = useTeamSocket(ready ? businessParam : null, onEvent, onReconnect);

  // No live connection: read again every 15 seconds.
  useEffect(() => {
    if (socket === "open" || !ready) return;
    const timer = setInterval(() => {
      void loadThreads();
      if (activeRef.current) void loadMessages(activeRef.current);
    }, 15_000);
    return () => clearInterval(timer);
  }, [socket, ready, loadThreads, loadMessages]);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending.length, activeId]);

  // ---- derived ----------------------------------------------------------
  const me = data?.me ?? null;
  const active = data?.threads.find((t) => t.id === activeId) ?? null;
  const colleagues = data?.colleagues ?? [];
  const otherOf = useCallback(
    (thread: TeamThreadSummary) =>
      thread.memberA === me?.employeeId
        ? { id: thread.memberB, name: thread.memberBName }
        : { id: thread.memberA, name: thread.memberAName },
    [me?.employeeId]
  );
  const directWith = (colleagueId: string) =>
    data?.threads.find((t) => t.kind === "direct" && (t.memberA === colleagueId || t.memberB === colleagueId));
  const mentionable: TeamColleague[] = useMemo(() => {
    if (!active) return [];
    if (active.kind === "room") return colleagues;
    const other = otherOf(active);
    return colleagues.filter((c) => c.id === other.id);
  }, [active, colleagues, otherOf]);

  // ---- actions ----------------------------------------------------------
  async function openColleague(colleague: TeamColleague) {
    const existing = directWith(colleague.id);
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    setOpening(colleague.id);
    try {
      const { thread } = await openDirectChat(colleague.id);
      await loadThreads();
      setActiveId(thread.id);
    } catch (err) {
      setThreadError(readableError(err, "That chat could not be opened."));
    } finally {
      setOpening(null);
    }
  }

  async function deliver(item: Pending) {
    try {
      const { message } = await sendTeamMessage(item.threadId, {
        clientId: item.clientId,
        body: item.body,
        mentions: item.mentions,
      });
      setPending((list) => list.filter((p) => p.clientId !== item.clientId));
      if (activeRef.current === item.threadId) {
        setMessages((list) => (list.some((m) => m.id === message.id) ? list : [...list, message]));
      }
      void loadThreads();
    } catch {
      setPending((list) => list.map((p) => (p.clientId === item.clientId ? { ...p, status: "failed" } : p)));
    }
  }

  function retry(pending: Pending) {
    setPending((list) => list.map((p) => (p.clientId === pending.clientId ? { ...p, status: "sending" } : p)));
    void deliver({ ...pending, status: "sending" });
  }

  function send() {
    const body = draft.trim();
    if (!body || !activeId || !canPost) return;
    const mentions = Object.entries(mentionIds)
      .filter(([name]) => body.includes(`@${name}`))
      .map(([, id]) => id);
    const item: Pending = { clientId: crypto.randomUUID(), threadId: activeId, body, mentions, status: "sending" };
    setPending((list) => [...list, item]);
    setDraft("");
    setMentionIds({});
    void deliver(item);
  }

  async function remove(message: TeamChatMessage) {
    try {
      const { message: removed } = await removeTeamChatMessage(message.id);
      setMessages((list) => list.map((m) => (m.id === removed.id ? { ...m, ...removed, share: null } : m)));
    } catch (err) {
      setThreadError(readableError(err, "That message could not be removed."));
    }
  }

  async function loadEarlier() {
    if (!activeId || messages.length === 0) return;
    try {
      const page = await getTeamMessages(activeId, messages[0]!.createdAt);
      setMessages((list) => [...page.messages.filter((m) => !list.some((x) => x.id === m.id)), ...list]);
      setHasEarlier(page.messages.length >= PAGE_SIZE);
    } catch (err) {
      setThreadError(readableError(err, "Earlier messages could not be loaded."));
    }
  }

  // "@" at the end of the draft offers colleagues.
  const mentionQuery = /(?:^|\s)@([\p{L}\p{N} ]{0,30})$/u.exec(draft)?.[1] ?? null;
  const suggestions =
    mentionQuery === null
      ? []
      : mentionable.filter((c) => c.fullName.toLowerCase().startsWith(mentionQuery.toLowerCase())).slice(0, 6);
  function pickMention(colleague: TeamColleague) {
    setDraft((text) => text.replace(/@([\p{L}\p{N} ]{0,30})$/u, `@${colleague.fullName} `));
    setMentionIds((ids) => ({ ...ids, [colleague.fullName]: colleague.id }));
  }

  // ---- render -----------------------------------------------------------
  const threadTitle = !active
    ? ""
    : active.kind === "room"
      ? `${data?.business.name ?? ""} team`
      : me?.isAdmin
        ? `${active.memberAName ?? "?"} & ${active.memberBName ?? "?"}`
        : (otherOf(active).name ?? "Colleague");
  const myLast = [...messages].reverse().find((m) => m.authorEmployeeId && m.authorEmployeeId === me?.employeeId);
  const seen = active?.kind === "direct" && myLast && seenByOther && seenByOther >= myLast.createdAt;

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root tc-root">
        <header className="act-head">
          <h1>Team chat</h1>
          <p className="act-lede">
            {me?.isAdmin
              ? "Every business's team room and every direct chat between its staff. You can write in the team rooms; direct chats are read only."
              : "Talk to your colleagues: the whole team in one room, or one person directly. Only people who work at your business are here."}
          </p>
        </header>

        {isOperator ? (
          <BusinessTabs value={business} onChange={(slug) => setBusiness(slug)} includeAll={false} />
        ) : null}

        {!me?.isAdmin && data ? <p className="tc-honest">Your admin can read team chats.</p> : null}

        {loadError ? (
          <p className="tc-error" role="alert">
            {loadError}{" "}
            <button type="button" onClick={() => void loadThreads()}>
              Try again
            </button>
          </p>
        ) : null}

        {data ? (
          <div className={`tc-shell${activeId ? " has-active" : ""}`}>
            <aside className="tc-list" aria-label="Chats">
              {data.threads
                .filter((t) => t.kind === "room")
                .map((room) => (
                  <button
                    key={room.id}
                    type="button"
                    className={`tc-item tc-room${room.id === activeId ? " on" : ""}`}
                    onClick={() => setActiveId(room.id)}
                  >
                    <span className="tc-av tc-av-room" aria-hidden="true">
                      #
                    </span>
                    <span className="tc-item-text">
                      <b>{data.business.name} team</b>
                      <small>{preview(room)}</small>
                    </span>
                    <Badges thread={room} />
                  </button>
                ))}

              <p className="tc-group">{me?.isAdmin ? "Direct chats" : "Colleagues"}</p>

              {me?.isAdmin ? (
                data.threads.filter((t) => t.kind === "direct").length === 0 ? (
                  <p className="tc-empty-small">No direct chats yet.</p>
                ) : (
                  data.threads
                    .filter((t) => t.kind === "direct")
                    .map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className={`tc-item${t.id === activeId ? " on" : ""}`}
                        onClick={() => setActiveId(t.id)}
                      >
                        <span className="tc-av" aria-hidden="true">
                          {initials(t.memberAName)}
                        </span>
                        <span className="tc-item-text">
                          <b>
                            {t.memberAName} &amp; {t.memberBName}
                          </b>
                          <small>{preview(t)}</small>
                        </span>
                        <Badges thread={t} />
                      </button>
                    ))
                )
              ) : colleagues.length === 0 ? (
                <p className="tc-empty-small">Nobody else works here yet.</p>
              ) : (
                colleagues.map((colleague) => {
                  const thread = directWith(colleague.id);
                  return (
                    <button
                      key={colleague.id}
                      type="button"
                      className={`tc-item${thread && thread.id === activeId ? " on" : ""}`}
                      onClick={() => void openColleague(colleague)}
                      disabled={opening === colleague.id}
                    >
                      <span className="tc-av" aria-hidden="true">
                        {colleague.avatarUrl ? <img src={colleague.avatarUrl} alt="" /> : initials(colleague.fullName)}
                        <i className={`tc-dot${colleague.onShift ? " on" : ""}`} />
                      </span>
                      <span className="tc-item-text">
                        <b>{colleague.fullName}</b>
                        <small>
                          {thread?.lastMessage ? preview(thread) : colleague.onShift ? "On shift now" : (colleague.jobTitle ?? "Off shift")}
                        </small>
                      </span>
                      {thread ? <Badges thread={thread} /> : null}
                    </button>
                  );
                })
              )}
            </aside>

            <section className="tc-thread" aria-label={threadTitle || "Chat"}>
              {active ? (
                <>
                  <header className="tc-thread-head">
                    <button type="button" className="tc-back" onClick={() => setActiveId(null)} aria-label="Back to chats">
                      ←
                    </button>
                    <div>
                      <h2>{threadTitle}</h2>
                      <small>
                        {active.kind === "room"
                          ? `Everyone at ${data.business.name} · ${colleagues.length + (me?.isAdmin ? 0 : 1)} people`
                          : me?.isAdmin
                            ? "Direct chat"
                            : colleagues.find((c) => c.id === otherOf(active).id)?.onShift
                              ? "On shift now"
                              : "Off shift — they will see it when they are back"}
                      </small>
                    </div>
                    {socket !== "open" && socket !== "off" ? (
                      <span className="tc-live off">Reconnecting…</span>
                    ) : socket === "open" ? (
                      <span className="tc-live">Live</span>
                    ) : null}
                  </header>

                  <div className="tc-messages">
                    {hasEarlier ? (
                      <button type="button" className="tc-earlier" onClick={() => void loadEarlier()}>
                        Show earlier messages
                      </button>
                    ) : null}
                    {messages.length === 0 && pending.filter((p) => p.threadId === activeId).length === 0 ? (
                      <p className="tc-empty">
                        {active.kind === "room" ? "Nothing said yet. Say hello to the team." : "No messages yet."}
                      </p>
                    ) : null}
                    {messages.map((message, index) => {
                      const mine =
                        (message.authorEmployeeId && message.authorEmployeeId === me?.employeeId) ||
                        (message.authorIsAdmin && me?.isAdmin);
                      const day = dayLabel(message.createdAt);
                      const showDay = index === 0 || dayLabel(messages[index - 1]!.createdAt) !== day;
                      const forMe = !!me?.employeeId && message.mentions.includes(me.employeeId);
                      return (
                        <div key={message.id}>
                          {showDay ? <p className="tc-day">{day}</p> : null}
                          <div className={`tc-msg${mine ? " mine" : ""}${forMe ? " for-me" : ""}`}>
                            {!mine ? (
                              <span className="tc-author">
                                {message.authorName}
                                {message.authorIsAdmin ? <em className="tc-admin">Admin</em> : null}
                              </span>
                            ) : null}
                            {message.deletedAt ? (
                              <p className="tc-bubble removed">Message removed</p>
                            ) : (
                              <div className="tc-bubble">
                                <p>{message.body}</p>
                                {message.share ? (
                                  <a className="tc-share" href={`/inbox?conversation=${message.share.conversationId}`}>
                                    <b>{message.share.name}</b>
                                    <span>{channelName(message.share.channel)} customer · Open chat →</span>
                                  </a>
                                ) : null}
                              </div>
                            )}
                            <span className="tc-meta">
                              {time(message.createdAt)}
                              {mine && !message.deletedAt && !me?.isAdmin ? (
                                <button type="button" className="tc-remove" onClick={() => void remove(message)}>
                                  Remove
                                </button>
                              ) : null}
                              {seen && message.id === myLast?.id ? <span className="tc-seen">Seen</span> : null}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                    {pending
                      .filter((p) => p.threadId === activeId)
                      .map((p) => (
                        <div key={p.clientId} className={`tc-msg mine ${p.status}`}>
                          <div className="tc-bubble">
                            <p>{p.body}</p>
                          </div>
                          <span className="tc-meta">
                            {p.status === "sending" ? (
                              "Sending…"
                            ) : (
                              <button type="button" className="tc-retry" onClick={() => retry(p)}>
                                Not sent · Retry
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    <div ref={listEnd} />
                  </div>

                  {threadError ? (
                    <p className="tc-error" role="alert">
                      {threadError}
                    </p>
                  ) : null}

                  {canPost ? (
                    <form
                      className="tc-compose"
                      onSubmit={(event) => {
                        event.preventDefault();
                        send();
                      }}
                    >
                      {suggestions.length > 0 ? (
                        <ul className="tc-suggest" role="listbox" aria-label="Mention a colleague">
                          {suggestions.map((c) => (
                            <li key={c.id}>
                              <button type="button" onClick={() => pickMention(c)}>
                                @{c.fullName}
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            if (suggestions.length > 0) pickMention(suggestions[0]!);
                            else send();
                          }
                        }}
                        placeholder={
                          active.kind === "room"
                            ? `Message the ${data.business.name} team — type @ to mention someone`
                            : `Message ${threadTitle}`
                        }
                        rows={2}
                        maxLength={4000}
                        aria-label="Message"
                      />
                      <button type="submit" disabled={!draft.trim()}>
                        Send
                      </button>
                    </form>
                  ) : active.kind === "direct" && me?.isAdmin ? (
                    <p className="tc-readonly">
                      Read only — between {active.memberAName} and {active.memberBName}.
                    </p>
                  ) : null}
                </>
              ) : (
                <p className="tc-empty tc-pick">Choose the team room or a colleague.</p>
              )}
            </section>
          </div>
        ) : !loadError ? (
          <p className="tc-empty">Loading team chat…</p>
        ) : null}
      </div>
    </div>
  );
}

function Badges({ thread }: { thread: TeamThreadSummary }) {
  if (thread.unread === 0) return null;
  return (
    <span className={`tc-badge${thread.mentioned > 0 ? " hot" : ""}`} title={thread.mentioned > 0 ? "You were mentioned" : undefined}>
      {thread.mentioned > 0 ? "@" : ""}
      {thread.unread}
    </span>
  );
}

function preview(thread: TeamThreadSummary): string {
  const last = thread.lastMessage;
  if (!last) return thread.kind === "room" ? "Everyone at this business" : "No messages yet";
  return last.removed ? `${last.authorName}: message removed` : `${last.authorName}: ${last.body}`;
}

function initials(name: string | null): string {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

function channelName(channel: string): string {
  if (channel === "email") return "Email";
  if (channel === "instagram") return "Instagram";
  if (channel === "facebook") return "Facebook";
  return "WhatsApp";
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}
