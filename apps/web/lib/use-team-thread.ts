"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearTeamReaction,
  getTeamMessages,
  markTeamThreadRead,
  readableError,
  removeTeamChatMessage,
  sendTeamMessage,
  sendTeamTyping,
  setTeamReaction,
  uploadTeamMessage,
  type TeamChatMessage,
} from "./api";
import { mineOf, toggleReaction } from "./team-chat/reactions";
import { pendingFor } from "./team-chat/pending";
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
 *
 * Since 2 Nov 2026 (WhatsApp-style staff chat) the same rules carry voice
 * notes, photos and files: the file stays in memory, with its id, until the
 * server confirms it, so a retry sends the same file under the same id; its
 * progress shows on the bubble and it can be cancelled; and a finished upload
 * lands only in the thread it was made in. Reactions change at once and are
 * put back if the server refuses them.
 */
export interface PendingFile {
  kind: "voice" | "photo" | "file";
  blob: Blob;
  name: string;
  preview?: Blob;
  width?: number;
  height?: number;
  durationMs?: number;
  waveform?: number[];
  /** 0–1, from the upload's progress events. */
  progress: number;
}

export interface PendingMessage {
  clientId: string;
  threadId: string;
  body: string;
  mentions: string[];
  status: "sending" | "failed";
  replyTo?: string;
  file?: PendingFile;
}

export const TEAM_PAGE_SIZE = 50;
const TYPING_SHOWN_MS = 5_000;
const TYPING_SENT_EVERY_MS = 3_000;

const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";

function formFor(item: PendingMessage): FormData {
  const form = new FormData();
  const file = item.file!;
  form.append("clientId", item.clientId);
  form.append("body", item.body);
  form.append("kind", file.kind);
  form.append("mentions", JSON.stringify(item.mentions));
  if (item.replyTo) form.append("replyTo", item.replyTo);
  if (file.preview) form.append("preview", file.preview, "preview.jpg");
  if (file.width) form.append("width", String(file.width));
  if (file.height) form.append("height", String(file.height));
  if (file.durationMs) form.append("durationMs", String(Math.round(file.durationMs)));
  if (file.waveform) form.append("waveform", JSON.stringify(file.waveform));
  // Last, so the fields are read before the bytes on the way in.
  form.append("file", file.blob, file.name);
  return form;
}

export function useTeamThread(
  threadId: string | null,
  myEmployeeId: string | null,
  onChange?: () => void,
  /** How this viewer appears in reactions: TeamThreadsResponse.me.key. */
  myReaderKey: string | null = null
) {
  const [messages, setMessages] = useState<TeamChatMessage[]>([]);
  const [canPost, setCanPost] = useState(false);
  const [seenByOther, setSeenByOther] = useState<string | null>(null);
  const [seenByAllAt, setSeenByAllAt] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [hasEarlier, setHasEarlier] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [typingName, setTypingName] = useState<string | null>(null);
  const [replyingTo, setReplyingTo] = useState<TeamChatMessage | null>(null);
  const activeRef = useRef<string | null>(threadId);
  activeRef.current = threadId;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastTypingSent = useRef(0);
  const uploads = useRef(new Map<string, AbortController>());

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
      setSeenByAllAt(page.seenByAllAt ?? null);
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
    setReplyingTo(null);
    setSeenByAllAt(null);
    if (!threadId) return;
    // Pending sends of other chats are kept (final review): an upload still
    // going, or failed, in the room is there with its Retry when you come back.
    void load(threadId);
  }, [threadId, load]);

  const reload = useCallback(() => {
    if (activeRef.current) void load(activeRef.current);
  }, [load]);

  const setProgress = (clientId: string, fraction: number) =>
    setPending((list) =>
      list.map((p) => (p.clientId === clientId && p.file ? { ...p, file: { ...p.file, progress: fraction } } : p))
    );

  async function deliver(item: PendingMessage, shareConversationId?: string) {
    try {
      let message: TeamChatMessage;
      if (item.file) {
        const controller = new AbortController();
        uploads.current.set(item.clientId, controller);
        ({ message } = await uploadTeamMessage(
          item.threadId,
          formFor(item),
          (fraction) => setProgress(item.clientId, fraction),
          controller.signal
        ));
      } else {
        ({ message } = await sendTeamMessage(item.threadId, {
          clientId: item.clientId,
          body: item.body,
          mentions: item.mentions,
          shareConversationId,
          replyTo: item.replyTo,
        }));
      }
      uploads.current.delete(item.clientId);
      setPending((list) => list.filter((p) => p.clientId !== item.clientId));
      // Only into the thread it was made in: a note recorded in the room and
      // finished after switching to a direct chat must not appear there.
      if (activeRef.current === item.threadId) {
        setMessages((list) => (list.some((m) => m.id === message.id) ? list : [...list, message]));
      }
      changeRef.current?.();
    } catch (err) {
      uploads.current.delete(item.clientId);
      // Cancelled: cancel() has already taken it off the screen.
      if (isAbort(err)) return;
      setPending((list) => list.map((p) => (p.clientId === item.clientId ? { ...p, status: "failed" } : p)));
    }
  }

  function retry(pending: PendingMessage) {
    const again: PendingMessage = {
      ...pending,
      status: "sending",
      file: pending.file ? { ...pending.file, progress: 0 } : undefined,
    };
    setPending((list) => list.map((p) => (p.clientId === pending.clientId ? again : p)));
    void deliver(again);
  }

  /** Queue a message; false when there is nothing to send or nowhere to send it. */
  function send(body: string, mentions: string[] = [], replyTo: string | undefined = replyingTo?.id): boolean {
    const text = body.trim();
    if (!text || !threadId || !canPost) return false;
    const item: PendingMessage = { clientId: crypto.randomUUID(), threadId, body: text, mentions, status: "sending", replyTo };
    setPending((list) => [...list, item]);
    if (activeRef.current === threadId) setReplyingTo(null);
    lastTypingSent.current = 0;
    void deliver(item);
    return true;
  }

  /** Queue a voice note, photo or file, with an optional caption. */
  function sendFile(
    file: Omit<PendingFile, "progress">,
    caption = "",
    replyTo: string | undefined = replyingTo?.id
  ): boolean {
    if (!threadId || !canPost) return false;
    const item: PendingMessage = {
      clientId: crypto.randomUUID(),
      threadId,
      body: caption.trim(),
      mentions: [],
      status: "sending",
      replyTo,
      file: { ...file, progress: 0 },
    };
    setPending((list) => [...list, item]);
    if (activeRef.current === threadId) setReplyingTo(null);
    void deliver(item);
    return true;
  }

  /** Stop an upload and take it off the screen. */
  function cancel(clientId: string) {
    uploads.current.get(clientId)?.abort();
    uploads.current.delete(clientId);
    setPending((list) => list.filter((p) => p.clientId !== clientId));
  }

  const setReactions = (messageId: string, reactions: TeamChatMessage["reactions"]) =>
    setMessages((list) => list.map((m) => (m.id === messageId ? { ...m, reactions } : m)));

  /** React (or un-react) at once; put it back if the server refuses. */
  function react(message: TeamChatMessage, emoji: string) {
    if (!threadId || !canPost || !myReaderKey || message.deletedAt) return;
    const before = message.reactions ?? [];
    const removing = mineOf(before, myReaderKey) === emoji;
    setReactions(message.id, toggleReaction(before, emoji, { key: myReaderKey, name: "You" }));
    const call = removing
      ? clearTeamReaction(threadId, message.id)
      : setTeamReaction(threadId, message.id, emoji);
    call
      .then(({ reactions }) => setReactions(message.id, reactions))
      .catch(() => {
        setReactions(message.id, before);
        setError("That reaction could not be saved.");
      });
  }

  async function remove(message: TeamChatMessage) {
    try {
      const { message: removed } = await removeTeamChatMessage(message.id);
      setMessages((list) =>
        list.map((m) => (m.id === removed.id ? { ...m, ...removed, share: null, file: null, replyTo: null } : m))
      );
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
      setMessages((list) =>
        list.map((m) => (m.id === removed.id ? { ...m, ...removed, share: null, file: null, replyTo: null } : m))
      );
    } else if (event.type === "team_reaction" && event.messageId && event.reactions) {
      setReactions(event.messageId, event.reactions);
    } else if (event.type === "team_read") {
      if (event.seenByAllAt !== undefined) setSeenByAllAt(event.seenByAllAt);
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
    pending: pendingFor(pending, threadId),
    canPost,
    seenByOther,
    seenByAllAt,
    hasEarlier,
    error,
    setError,
    typingName,
    replyingTo,
    setReplyingTo,
    myKey: myReaderKey,
    send,
    sendFile,
    cancel,
    react,
    retry,
    remove,
    loadEarlier,
    reload,
    notifyTyping,
    onEvent,
  };
}

export type TeamThreadState = ReturnType<typeof useTeamThread>;
