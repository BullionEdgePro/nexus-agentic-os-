"use client";

import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import type { TeamThreadState } from "@/lib/use-team-thread";
import { groupRuns } from "@/lib/team-chat/runs";
import { nameColourIndex } from "@/lib/team-chat/name-colour";
import { GESTURES, isLongPress, swipeReply } from "@/lib/team-chat/gestures";
import { mineOf } from "@/lib/team-chat/reactions";
import { MessageMenu } from "./team-chat/message-menu";
import { Reactions } from "./team-chat/reactions";
import { FileBubble } from "./team-chat/file-bubble";
import { PhotoViewer } from "./team-chat/photo-viewer";
import "./team-chat/team-chat.css";

type TeamChatMessage = TeamThreadState["messages"][number];

/**
 * The messages of one team chat thread (24 Oct 2026): on the Team chat page and
 * in the dock beside the inbox, drawn the same way from the same state.
 *
 * Since 2 Nov 2026 drawn as a WhatsApp group: a run of messages from one person
 * shows their name (in their own colour) and the bubble's tail once; time and
 * ticks sit inside the bubble (🕓 sending, ✓ sent, ✓✓ seen — by the colleague
 * in a direct chat, by everyone in the room); a reply carries a quote that
 * jumps to the message it answers; and a strip marks where unread messages
 * begin. Spec: docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md §1
 */
export function ThreadMessages({
  thread,
  me,
  kind,
  emptyText,
  unreadAtOpen = 0,
}: {
  thread: TeamThreadState;
  me: { employeeId: string | null; isAdmin: boolean } | null;
  kind: "room" | "direct";
  emptyText: string;
  /** The thread's unread count when it was opened: where the strip goes. */
  unreadAtOpen?: number;
}) {
  const end = useRef<HTMLDivElement | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ threadId: string; file: NonNullable<TeamChatMessage["file"]> } | null>(null);
  const { messages, pending } = thread;
  const lastId = messages.at(-1)?.id ?? null;

  // Follow new messages at the end — not when earlier ones are loaded above.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lastId, pending.length, thread.typingName]);

  // Where unread messages began, fixed when the thread's messages first arrive.
  const unread = useRef<{ thread: string | null; id: string | null; count: number }>({ thread: null, id: null, count: 0 });
  const threadKey = messages[0]?.threadId ?? null;
  if (threadKey && unread.current.thread !== threadKey) {
    const count = Math.min(unreadAtOpen, messages.length);
    unread.current = { thread: threadKey, id: count > 0 ? (messages[messages.length - count]?.id ?? null) : null, count };
  }

  const runStarts = groupRuns(messages);
  const seenAt = kind === "direct" ? thread.seenByOther : thread.seenByAllAt;
  const showNames = kind === "room" || !!me?.isAdmin;

  async function jumpTo(id: string) {
    const smooth = window.matchMedia("(prefers-reduced-motion: no-preference)").matches;
    for (let tries = 0; tries <= 5; tries += 1) {
      const target = document.getElementById(`tc-m-${id}`);
      if (target) {
        target.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "auto" });
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 1200);
        return;
      }
      if (!thread.hasEarlier || tries === 5) break;
      await thread.loadEarlier();
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    }
    thread.setError("That message is older than this chat shows.");
  }

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
        const first = runStarts[index] || showDay;
        const forMe = !!me?.employeeId && message.mentions.includes(me.employeeId);
        const removed = !!message.deletedAt;
        // Reacting, replying and removing are writing: not for the admin in a direct chat.
        const interactive = thread.canPost ? !removed : false;
        // A fragment, not a wrapper: the day pill and the bubble sit straight in
        // the scrolling list, so the pill can float while its day scrolls past.
        return (
          <Fragment key={message.id}>
            {showDay ? <p className="tc-day">{day}</p> : null}
            {unread.current.id === message.id ? (
              <p className="tc-unread-strip">
                {unread.current.count} unread message{unread.current.count === 1 ? "" : "s"}
              </p>
            ) : null}
            <div
              id={`tc-m-${message.id}`}
              className={`tc-msg${mine ? " mine" : ""}${first ? " first" : ""}${forMe ? " for-me" : ""}${menuFor === message.id ? " lifted" : ""}`}
            >
              <Swipeable
                enabled={interactive}
                onHold={() => setMenuFor(message.id)}
                onSwipe={() => thread.setReplyingTo(message)}
              >
              <div
                className={`tc-bubble${removed ? " removed" : ""}`}
                tabIndex={interactive ? 0 : undefined}
                aria-haspopup={interactive ? "menu" : undefined}
                onKeyDown={(event) => {
                  if (interactive && event.key === "Enter" && event.target === event.currentTarget) {
                    event.preventDefault();
                    setMenuFor(message.id);
                  }
                }}
              >
                {!mine && first && showNames ? <Author message={message} /> : null}
                {removed ? (
                  <p>Message removed</p>
                ) : (
                  <>
                    {message.replyTo ? <Quote reply={message.replyTo} onJump={() => void jumpTo(message.replyTo!.id)} /> : null}
                    {message.file ? (
                      <FileBubble
                        file={message.file}
                        threadId={message.threadId}
                        mine={!!mine}
                        onOpenPhoto={(file) => setViewing({ threadId: message.threadId, file })}
                      />
                    ) : null}
                    {message.body ? <p>{message.body}</p> : null}
                    {message.share ? (
                      <a className="tc-share" href={`/inbox?conversation=${message.share.conversationId}`}>
                        <b>{message.share.name}</b>
                        <span>{channelName(message.share.channel)} customer · Open chat →</span>
                      </a>
                    ) : null}
                  </>
                )}
                <span className="tc-time">
                  {time(message.createdAt)}
                  {mine && !removed ? <Ticks state={seenAt && seenAt >= message.createdAt ? "seen" : "sent"} /> : null}
                </span>
              </div>
              </Swipeable>
              {interactive ? (
                <button
                  type="button"
                  className="tc-hover-tool"
                  aria-label="React, reply or more"
                  onClick={() => setMenuFor(message.id)}
                >
                  🙂
                </button>
              ) : null}
              {!removed ? (
                <Reactions
                  reactions={message.reactions ?? []}
                  myKey={thread.myKey}
                  canReact={interactive}
                  onToggle={(emoji) => thread.react(message, emoji)}
                />
              ) : null}
              {menuFor === message.id ? (
                <MessageMenu
                  message={message}
                  mine={!!mine && !me?.isAdmin}
                  myReaction={thread.myKey ? mineOf(message.reactions ?? [], thread.myKey) : null}
                  onReact={(emoji) => thread.react(message, emoji)}
                  onReply={() => thread.setReplyingTo(message)}
                  onRemove={() => void thread.remove(message)}
                  onClose={() => setMenuFor(null)}
                />
              ) : null}
            </div>
          </Fragment>
        );
      })}
      {pending.map((p) => (
        <div key={p.clientId} className={`tc-msg mine first ${p.status}`}>
          <div className="tc-bubble">
            {p.file ? (
              <div className="tc-upload">
                <Progress fraction={p.file.progress} failed={p.status === "failed"} />
                <span>{pendingLabel(p.file.kind, p.file.name)}</span>
                {p.status === "sending" ? (
                  <button type="button" className="tc-upload-cancel" aria-label="Cancel upload" onClick={() => thread.cancel(p.clientId)}>
                    ✕
                  </button>
                ) : null}
              </div>
            ) : null}
            {p.body ? <p>{p.body}</p> : null}
            {p.status === "sending" ? (
              <span className="tc-time">
                <Ticks state="sending" />
              </span>
            ) : null}
          </div>
          {p.status === "failed" ? (
            <span className="tc-meta">
              <button type="button" className="tc-retry" onClick={() => thread.retry(p)}>
                Not sent · Retry
              </button>
            </span>
          ) : null}
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
      {menuFor ? <div className="tc-dim" aria-hidden="true" onClick={() => setMenuFor(null)} /> : null}
      {viewing ? <PhotoViewer threadId={viewing.threadId} file={viewing.file} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

/**
 * A bubble's touch gestures (2 Nov 2026): hold still to open the reactions and
 * menu; swipe right to reply, with the bubble following the finger. Vertical
 * movement is left to the page (touch-action: pan-y), so scrolling the chat
 * never counts as either. A mouse uses the hover button instead.
 */
function Swipeable({
  enabled,
  onHold,
  onSwipe,
  children,
}: {
  enabled: boolean;
  onHold: () => void;
  onSwipe: () => void;
  children: ReactNode;
}) {
  const start = useRef<{ x: number; y: number; t: number } | null>(null);
  const moved = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [dx, setDx] = useState(0);

  const reset = () => {
    if (timer.current) clearTimeout(timer.current);
    start.current = null;
    moved.current = 0;
    setDx(0);
  };

  return (
    <div
      className="tc-swipe"
      style={dx ? { transform: `translateX(${dx}px)` } : undefined}
      onPointerDown={(event) => {
        if (!enabled || event.pointerType === "mouse") return;
        start.current = { x: event.clientX, y: event.clientY, t: performance.now() };
        moved.current = 0;
        timer.current = setTimeout(() => {
          if (start.current && isLongPress(performance.now() - start.current.t, moved.current)) {
            navigator.vibrate?.(12);
            onHold();
            reset();
          }
        }, GESTURES.holdMs);
      }}
      onPointerMove={(event) => {
        const from = start.current;
        if (!from) return;
        const x = event.clientX - from.x;
        const y = event.clientY - from.y;
        moved.current = Math.max(moved.current, Math.hypot(x, y));
        if (moved.current >= 10 && timer.current) clearTimeout(timer.current);
        if (x > 0 && Math.abs(y) < 32) setDx(Math.min(x, 90));
      }}
      onPointerUp={(event) => {
        const from = start.current;
        if (from && swipeReply(event.clientX - from.x, event.clientY - from.y)) onSwipe();
        reset();
      }}
      onPointerCancel={reset}
      onContextMenu={(event) => {
        if (enabled && event.nativeEvent instanceof PointerEvent && event.nativeEvent.pointerType !== "mouse") {
          event.preventDefault();
        }
      }}
    >
      {dx > 20 ? (
        <span className="tc-swipe-reply" aria-hidden="true" style={{ opacity: Math.min(1, dx / 64) }}>
          ↩
        </span>
      ) : null}
      {children}
    </div>
  );
}

/** An upload's progress, as a ring that fills. */
function Progress({ fraction, failed }: { fraction: number; failed: boolean }) {
  const r = 13;
  const circumference = 2 * Math.PI * r;
  return (
    <svg className={`tc-ring${failed ? " failed" : ""}`} width="32" height="32" viewBox="0 0 32 32" role="img" aria-label={failed ? "Not sent" : `${Math.round(fraction * 100)}% sent`}>
      <circle cx="16" cy="16" r={r} className="tc-ring-track" />
      <circle
        cx="16"
        cy="16"
        r={r}
        className="tc-ring-fill"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0.04, fraction)))}
        transform="rotate(-90 16 16)"
      />
    </svg>
  );
}

/** The writer's name in their own colour (--tc-name-0…7); the admin's in ink with its label. */
function Author({ message }: { message: TeamChatMessage }) {
  return (
    <span
      className="tc-author"
      data-name={message.authorIsAdmin ? undefined : nameColourIndex(message.authorEmployeeId ?? message.authorName)}
    >
      {message.authorName}
      {message.authorIsAdmin ? <em className="tc-admin">Admin</em> : null}
    </span>
  );
}

function Quote({
  reply,
  onJump,
}: {
  reply: NonNullable<TeamChatMessage["replyTo"]>;
  onJump: () => void;
}) {
  return (
    <button type="button" className="tc-quote" onClick={onJump} style={{ color: "var(--signal-text)" }}>
      <b>{reply.authorName}</b>
      <span>{reply.snippet}</span>
    </button>
  );
}

function Ticks({ state }: { state: "sending" | "sent" | "seen" }) {
  const label = state === "sending" ? "Sending" : state === "seen" ? "Seen" : "Sent";
  return (
    <span className="tc-ticks" data-state={state} role="img" aria-label={label} title={label}>
      {state === "sending" ? "🕓" : state === "seen" ? "✓✓" : "✓"}
    </span>
  );
}

function pendingLabel(kind: "voice" | "photo" | "file", name: string): string {
  if (kind === "voice") return "🎤 Voice note";
  if (kind === "photo") return "📷 Photo";
  return `📄 ${name}`;
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
