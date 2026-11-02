"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { BusinessTabs, useVisibleBusinesses } from "@/lib/business-tabs";
import {
  getTeamThreads,
  openDirectChat,
  readableError,
  type TeamColleague,
  type TeamThreadSummary,
  type TeamThreadsResponse,
} from "@/lib/api";
import { useTeamSocket, type TeamSocketEvent } from "@/lib/use-team-socket";
import { useTeamThread } from "@/lib/use-team-thread";
import { ThreadMessages } from "../../team-chat-thread";
import { TeamComposer } from "../../team-chat/composer";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../activity/activity.css";
import "../../team-chat/team-chat.css";

/**
 * Team chat — staff of one business talking to each other (24 Oct 2026).
 *
 * The team room first, then each colleague; one thread open at a time. The
 * admin picks a business, reads everything, and writes only in the room.
 * Spec: docs/superpowers/specs/2026-10-24-team-chat-design.md
 *
 * RELIABILITY lives in useTeamThread (shared with the dock beside the inbox):
 * "Sending…" then "Not sent · Retry" with the same id, merged live events,
 * and a re-read when the connection comes back — here also every 15 seconds
 * while there is no connection at all.
 */
export default function TeamChatPage() {
  const { isOperator, known } = useVisibleBusinesses();
  const [business, setBusiness] = useState<BusinessSlug | "">("");
  const [data, setData] = useState<TeamThreadsResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [unreadAtOpen, setUnreadAtOpen] = useState(0);

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

  const thread = useTeamThread(activeId, data?.me.employeeId ?? null, () => void loadThreads(), data?.me.key ?? null);

  useEffect(() => {
    setActiveId(null);
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

  // ---- live -------------------------------------------------------------
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const onEvent = useCallback(
    (event: TeamSocketEvent) => {
      threadRef.current.onEvent(event);
      if (event.type === "team_message" || event.type === "team_message_removed") void loadThreads();
    },
    [loadThreads]
  );
  const onReconnect = useCallback(() => {
    void loadThreads();
    threadRef.current.reload();
  }, [loadThreads]);
  const socket = useTeamSocket(ready ? businessParam : null, onEvent, onReconnect);

  // No live connection: read again every 15 seconds.
  useEffect(() => {
    if (socket === "open" || !ready) return;
    const timer = setInterval(() => {
      void loadThreads();
      threadRef.current.reload();
    }, 15_000);
    return () => clearInterval(timer);
  }, [socket, ready, loadThreads]);

  // ---- derived ----------------------------------------------------------
  const me = data?.me ?? null;
  const active = data?.threads.find((t) => t.id === activeId) ?? null;
  const colleagues = data?.colleagues ?? [];
  const otherOf = useCallback(
    (t: TeamThreadSummary) =>
      t.memberA === me?.employeeId ? { id: t.memberB, name: t.memberBName } : { id: t.memberA, name: t.memberAName },
    [me?.employeeId]
  );
  const directWith = (colleagueId: string) =>
    data?.threads.find((t) => t.kind === "direct" && (t.memberA === colleagueId || t.memberB === colleagueId));
  // How much was unread when a chat was opened: the "N unread messages" strip.
  const latest = useRef(data);
  latest.current = data;
  useEffect(() => {
    setShowMembers(false);
    setUnreadAtOpen(latest.current?.threads.find((t) => t.id === activeId)?.unread ?? 0);
  }, [activeId]);

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
      const { thread: opened } = await openDirectChat(colleague.id);
      await loadThreads();
      setActiveId(opened.id);
    } catch (err) {
      thread.setError(readableError(err, "That chat could not be opened."));
    } finally {
      setOpening(null);
    }
  }

  // ---- render -----------------------------------------------------------
  const threadTitle = !active
    ? ""
    : active.kind === "room"
      ? `${data?.business.name ?? ""} team`
      : me?.isAdmin
        ? `${active.memberAName ?? "?"} & ${active.memberBName ?? "?"}`
        : (otherOf(active).name ?? "Colleague");

  // The header's members line and list, as WhatsApp's group header shows them.
  const members: Array<{ id: string; name: string; note: string | null }> = !active
    ? []
    : active.kind === "room"
      ? [
          ...colleagues.map((c) => ({ id: c.id, name: c.fullName, note: c.onShift ? "on shift" : null })),
          ...(me?.isAdmin ? [] : [{ id: "me", name: `${me?.name ?? "You"} (you)`, note: null }]),
        ]
      : [
          { id: active.memberA ?? "a", name: active.memberAName ?? "?", note: null },
          { id: active.memberB ?? "b", name: active.memberBName ?? "?", note: null },
        ];
  const headLine = !active
    ? ""
    : active.kind === "room"
      ? [...colleagues.map((c) => c.fullName.split(/\s+/)[0]), ...(me?.isAdmin ? [] : ["you"])].join(", ") ||
        `Everyone at ${data?.business.name ?? ""}`
      : me?.isAdmin
        ? "Direct chat"
        : colleagues.find((c) => c.id === otherOf(active).id)?.onShift
          ? "On shift now"
          : "Off shift — they will see it when they are back";

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
                  const direct = directWith(colleague.id);
                  return (
                    <button
                      key={colleague.id}
                      type="button"
                      className={`tc-item${direct && direct.id === activeId ? " on" : ""}`}
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
                          {direct?.lastMessage ? preview(direct) : colleague.onShift ? "On shift now" : (colleague.jobTitle ?? "Off shift")}
                        </small>
                      </span>
                      {direct ? <Badges thread={direct} /> : null}
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
                    <span className={`tc-av${active.kind === "room" ? " tc-av-room" : ""}`} aria-hidden="true">
                      {initials(active.kind === "room" ? data.business.name : threadTitle)}
                    </span>
                    <div className="tc-head-who">
                      <h2>{threadTitle}</h2>
                      <button
                        type="button"
                        className="tc-head-members"
                        aria-expanded={showMembers}
                        onClick={() => setShowMembers((open) => !open)}
                      >
                        {headLine}
                      </button>
                    </div>
                    {socket !== "open" && socket !== "off" ? (
                      <span className="tc-live off">Reconnecting…</span>
                    ) : socket === "open" ? (
                      <span className="tc-live">Live</span>
                    ) : null}
                    {showMembers ? (
                      <ul className="tc-members" aria-label="Members">
                        {members.map((member) => (
                          <li key={member.id}>
                            <span className="tc-av" aria-hidden="true">
                              {initials(member.name)}
                            </span>
                            <span>
                              {member.name}
                              {member.note ? <small> · {member.note}</small> : null}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </header>

                  <ThreadMessages
                    thread={thread}
                    me={me}
                    kind={active.kind}
                    emptyText={active.kind === "room" ? "Nothing said yet. Say hello to the team." : "No messages yet."}
                    unreadAtOpen={unreadAtOpen}
                  />

                  {thread.error ? (
                    <p className="tc-error" role="alert">
                      {thread.error}
                    </p>
                  ) : null}

                  {thread.canPost ? (
                    <TeamComposer
                      key={active.id}
                      thread={thread}
                      colleagues={mentionable}
                      placeholder={
                        active.kind === "room" ? "Message the team · @ to mention" : `Message ${threadTitle.split(/\s+/)[0]}`
                      }
                    />
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
  // A voice note, photo or file has no words of its own to show here.
  return last.removed ? `${last.authorName}: message removed` : `${last.authorName}: ${last.body || "📎 sent an attachment"}`;
}

function initials(name: string | null): string {
  return (name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
