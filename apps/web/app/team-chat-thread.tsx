"use client";

import { useEffect, useRef } from "react";
import type { TeamThreadState } from "@/lib/use-team-thread";
import "./deck/team-chat/team-chat.css";

/**
 * The messages of one team chat thread (24 Oct 2026): on the Team chat page and
 * in the dock beside the inbox, drawn the same way from the same state.
 */
export function ThreadMessages({
  thread,
  me,
  kind,
  emptyText,
}: {
  thread: TeamThreadState;
  me: { employeeId: string | null; isAdmin: boolean } | null;
  kind: "room" | "direct";
  emptyText: string;
}) {
  const end = useRef<HTMLDivElement | null>(null);
  const { messages, pending } = thread;

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending.length, thread.typingName]);

  const myLast = [...messages].reverse().find((m) => m.authorEmployeeId && m.authorEmployeeId === me?.employeeId);
  const seen = kind === "direct" && myLast && thread.seenByOther && thread.seenByOther >= myLast.createdAt;

  return (
    <div className="tc-messages">
      {thread.hasEarlier ? (
        <button type="button" className="tc-earlier" onClick={() => void thread.loadEarlier()}>
          Show earlier messages
        </button>
      ) : null}
      {messages.length === 0 && pending.length === 0 ? <p className="tc-empty">{emptyText}</p> : null}
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
                  <button type="button" className="tc-remove" onClick={() => void thread.remove(message)}>
                    Remove
                  </button>
                ) : null}
                {seen && message.id === myLast?.id ? <span className="tc-seen">Seen</span> : null}
              </span>
            </div>
          </div>
        );
      })}
      {pending.map((p) => (
        <div key={p.clientId} className={`tc-msg mine ${p.status}`}>
          <div className="tc-bubble">
            <p>{p.body}</p>
          </div>
          <span className="tc-meta">
            {p.status === "sending" ? (
              "Sending…"
            ) : (
              <button type="button" className="tc-retry" onClick={() => thread.retry(p)}>
                Not sent · Retry
              </button>
            )}
          </span>
        </div>
      ))}
      {thread.typingName ? (
        <p className="tc-typing" aria-live="polite">
          <span aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {thread.typingName} is typing
        </p>
      ) : null}
      <div ref={end} />
    </div>
  );
}

export function channelName(channel: string): string {
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
