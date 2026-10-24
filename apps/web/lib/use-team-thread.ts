"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getTeamMessages,
  markTeamThreadRead,
  readableError,
  removeTeamChatMessage,
  sendTeamMessage,
  sendTeamTyping,
  type TeamChatMessage,
} from "./api";
import type { TeamSocketEvent } from "./use-team-socket";

/**
 * One open team chat thread: its messages and how they are sent (24 Oct 2026).
 *
 * Shared by the Team chat page and the dock beside the inbox, so the rules
 * that make it reliable are written once:
 *   - a message shows at once as "Sending…", and becomes "Not sent · Retry"
 *     when the server never confirms it; a retry reuses its id, so the server
 *     keeps it once however many times it arrives;
 *   - live events for this thread are merged without duplicates; reload()
 *     re-reads it (the caller calls it when the connection comes back, and
 *     every 15 seconds when there is no connection);
 *   - "<name> is typing" shows for 5 seconds after a colleague's keystroke,
 *     and this screen tells others at most once every 3 seconds.
 */
export interface PendingMessage {
  clientId: string;
  threadId: string;
  body: string;
  mentions: string[];
  status: "sending" | "failed";
}

export const TEAM_PAGE_SIZE = 50;
const TYPING_SHOWN_MS = 5_000;
const TYPING_SENT_EVERY_MS = 3_000;

export function useTeamThread(threadId: string | null, myEmployeeId: string | null, onChange?: () => void) {
  const [messages, setMessages] = useState<TeamChatMessage[]>([]);
  const [canPost, setCanPost] = useState(false);
  const [seenByOther, setSeenByOther] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [hasEarlier, setHasEarlier] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [typingName, setTypingName] = useState<string | null>(null);
  const activeRef = useRef<string | null>(threadId);
  activeRef.current = threadId;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTypingSent = useRef(0);

  const markRead = (id: string) =>
    void markTeamThreadRead(id)
      .then(() => window.dispatchEvent(new Event("nexus:team-unread")))
      .catch(() => undefined);

  const load = useCallback(async (id: string) => {
    try {
      const page = await getTeamMessages(id);
      if (activeRef.current !== id) return;
      setMessages(page.messages);
      setCanPost(page.canPost);
      setSeenByOther(page.seenByOther);
      setHasEarlier(page.messages.length >= TEAM_PAGE_SIZE);
      setError("");
      markRead(id);
    } catch (err) {
      if (activeRef.current === id) setError(readableError(err, "This chat could not be loaded."));
    }
  }, []);

  useEffect(() => {
    setMessages([]);
    setTypingName(null);
    if (!threadId) return;
    setPending((list) => list.filter((p) => p.status === "failed" || p.threadId === threadId));
    void load(threadId);
  }, [threadId, load]);

  const reload = useCallback(() => {
    if (activeRef.current) void load(activeRef.current);
  }, [load]);

  async function deliver(item: PendingMessage, shareConversationId?: string) {
    try {
      const { message } = await sendTeamMessage(item.threadId, {
        clientId: item.clientId,
        body: item.body,
        mentions: item.mentions,
        shareConversationId,
      });
      setPending((list) => list.filter((p) => p.clientId !== item.clientId));
      if (activeRef.current === item.threadId) {
        setMessages((list) => (list.some((m) => m.id === message.id) ? list : [...list, message]));
      }
      changeRef.current?.();
    } catch {
      setPending((list) => list.map((p) => (p.clientId === item.clientId ? { ...p, status: "failed" } : p)));
    }
  }

  function retry(pending: PendingMessage) {
    setPending((list) => list.map((p) => (p.clientId === pending.clientId ? { ...p, status: "sending" } : p)));
    void deliver({ ...pending, status: "sending" });
  }

  /** Queue a message; false when there is nothing to send or nowhere to send it. */
  function send(body: string, mentions: string[] = []): boolean {
    const text = body.trim();
    if (!text || !threadId || !canPost) return false;
    const item: PendingMessage = { clientId: crypto.randomUUID(), threadId, body: text, mentions, status: "sending" };
    setPending((list) => [...list, item]);
    lastTypingSent.current = 0;
    void deliver(item);
    return true;
  }

  async function remove(message: TeamChatMessage) {
    try {
      const { message: removed } = await removeTeamChatMessage(message.id);
      setMessages((list) => list.map((m) => (m.id === removed.id ? { ...m, ...removed, share: null } : m)));
      changeRef.current?.();
    } catch (err) {
      setError(readableError(err, "That message could not be removed."));
    }
  }

  async function loadEarlier() {
    if (!threadId || messages.length === 0) return;
    try {
      const page = await getTeamMessages(threadId, messages[0]!.createdAt);
      setMessages((list) => [...page.messages.filter((m) => !list.some((x) => x.id === m.id)), ...list]);
      setHasEarlier(page.messages.length >= TEAM_PAGE_SIZE);
    } catch (err) {
      setError(readableError(err, "Earlier messages could not be loaded."));
    }
  }

  /** Called on each keystroke in the box; tells colleagues at most every 3 seconds. */
  function notifyTyping() {
    if (!threadId || !canPost) return;
    const now = Date.now();
    if (now - lastTypingSent.current < TYPING_SENT_EVERY_MS) return;
    lastTypingSent.current = now;
    void sendTeamTyping(threadId).catch(() => undefined);
  }

  /** Feed every team event here; only this thread's are used. */
  function onEvent(event: TeamSocketEvent) {
    if (event.threadId !== activeRef.current) return;
    if (event.type === "team_message" && event.message) {
      const incoming = event.message;
      setMessages((list) => (list.some((m) => m.id === incoming.id) ? list : [...list, incoming]));
      setPending((list) => list.filter((p) => p.clientId !== incoming.clientId));
      if (incoming.authorEmployeeId !== myEmployeeId) {
        setTypingName(null);
        markRead(event.threadId);
      }
    } else if (event.type === "team_message_removed" && event.message) {
      const removed = event.message;
      setMessages((list) => list.map((m) => (m.id === removed.id ? { ...m, ...removed, share: null } : m)));
    } else if (event.type === "team_read") {
      if (event.reader && event.reader !== myEmployeeId && !event.reader.startsWith("admin:")) {
        setSeenByOther(new Date().toISOString());
      }
    } else if (event.type === "team_typing") {
      if (!event.reader || event.reader === myEmployeeId) return;
      setTypingName(event.name ?? "Someone");
      if (typingTimer.current) clearTimeout(typingTimer.current);
      typingTimer.current = setTimeout(() => setTypingName(null), TYPING_SHOWN_MS);
    }
  }

  return {
    messages,
    pending: pending.filter((p) => p.threadId === threadId),
    canPost,
    seenByOther,
    hasEarlier,
    error,
    setError,
    typingName,
    send,
    retry,
    remove,
    loadEarlier,
    reload,
    notifyTyping,
    onEvent,
  };
}

export type TeamThreadState = ReturnType<typeof useTeamThread>;
