"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getTeamThreads, openDirectChat, readableError, type TeamThreadsResponse } from "@/lib/api";
import { useTeamSocket, type TeamSocketEvent } from "@/lib/use-team-socket";
import { useTeamThread } from "@/lib/use-team-thread";
import { ThreadMessages } from "../team-chat-thread";

/**
 * Team chat beside the work (24 Oct 2026, Focus workspace): the team room and
 * each colleague as tabs, docked where the customer panel was, so a staff
 * member asks the team without leaving the customer they are answering.
 *
 * Same thread state and the same reliability rules as the Team chat page
 * (useTeamThread): saved first, one id per send, retry, re-read on reconnect,
 * and every 15 seconds while there is no live connection.
 */
export function TeamDock({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<TeamThreadsResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getTeamThreads();
      setData(next);
      setLoadError("");
      setActiveId((current) => current ?? next.threads.find((t) => t.kind === "room")?.id ?? null);
    } catch (err) {
      setLoadError(readableError(err, "Team chat could not be loaded."));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const thread = useTeamThread(activeId, data?.me.employeeId ?? null, () => void load());
  const threadRef = useRef(thread);
  threadRef.current = thread;

  const onEvent = useCallback(
    (event: TeamSocketEvent) => {
      threadRef.current.onEvent(event);
      if (event.type === "team_message" || event.type === "team_message_removed") void load();
    },
    [load]
  );
  const onReconnect = useCallback(() => {
    void load();
    threadRef.current.reload();
  }, [load]);
  const socket = useTeamSocket(null, onEvent, onReconnect);

  useEffect(() => {
    if (socket === "open") return;
    const timer = setInterval(() => {
      void load();
      threadRef.current.reload();
    }, 15_000);
    return () => clearInterval(timer);
  }, [socket, load]);

  const me = data?.me ?? null;
  const room = data?.threads.find((t) => t.kind === "room") ?? null;
  const active = data?.threads.find((t) => t.id === activeId) ?? null;

  async function openColleague(colleagueId: string) {
    const existing = data?.threads.find(
      (t) => t.kind === "direct" && (t.memberA === colleagueId || t.memberB === colleagueId)
    );
    if (existing) {
      setActiveId(existing.id);
      return;
    }
    setOpening(colleagueId);
    try {
      const { thread: opened } = await openDirectChat(colleagueId);
      await load();
      setActiveId(opened.id);
    } catch (err) {
      thread.setError(readableError(err, "That chat could not be opened."));
    } finally {
      setOpening(null);
    }
  }

  function send() {
    if (thread.send(draft)) setDraft("");
  }

  const unreadFor = (colleagueId: string) =>
    data?.threads.find((t) => t.kind === "direct" && (t.memberA === colleagueId || t.memberB === colleagueId))?.unread ?? 0;
  const otherName = active && active.kind === "direct"
    ? active.memberA === me?.employeeId
      ? active.memberBName
      : active.memberAName
    : null;

  return (
    <section className="ibx-dock" aria-label="Team chat">
      <header className="ibx-dock-head">
        <b>Team chat</b>
        <span>{data?.business.name}</span>
        <a href="/deck/team-chat">Open full</a>
        <button type="button" aria-label="Close team chat" onClick={onClose}>
          ×
        </button>
      </header>
      {loadError ? <p className="tc-error">{loadError}</p> : null}
      {data ? (
        <div className="ibx-dock-tabs" role="tablist" aria-label="Chats">
          {room ? (
            <button
              type="button"
              role="tab"
              aria-selected={activeId === room.id}
              className={activeId === room.id ? "on" : undefined}
              onClick={() => setActiveId(room.id)}
            >
              Team{room.unread ? <span className={room.mentioned ? "hot" : undefined}>{room.unread}</span> : null}
            </button>
          ) : null}
          {data.colleagues.map((c) => (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={!!active && active.kind === "direct" && (active.memberA === c.id || active.memberB === c.id)}
              className={active && active.kind === "direct" && (active.memberA === c.id || active.memberB === c.id) ? "on" : undefined}
              disabled={opening === c.id}
              onClick={() => void openColleague(c.id)}
            >
              <i className={`tc-dot-inline${c.onShift ? " on" : ""}`} aria-hidden="true" />
              {c.fullName.split(/\s+/)[0]}
              {unreadFor(c.id) ? <span>{unreadFor(c.id)}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {active ? (
        <>
          <ThreadMessages
            thread={thread}
            me={me}
            kind={active.kind}
            emptyText={active.kind === "room" ? "Nothing said yet. Say hello to the team." : "No messages yet."}
          />
          {thread.error ? <p className="tc-error">{thread.error}</p> : null}
          {thread.canPost ? (
            <form
              className="tc-compose"
              onSubmit={(event) => {
                event.preventDefault();
                send();
              }}
            >
              <textarea
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  thread.notifyTyping();
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    send();
                  }
                }}
                placeholder={active.kind === "room" ? `Message the ${data?.business.name ?? ""} team` : `Message ${otherName ?? "your colleague"}`}
                rows={2}
                maxLength={4000}
                aria-label="Message"
              />
              <button type="submit" disabled={!draft.trim()}>
                Send
              </button>
            </form>
          ) : null}
        </>
      ) : !loadError ? (
        <p className="tc-empty">Loading…</p>
      ) : null}
    </section>
  );
}
