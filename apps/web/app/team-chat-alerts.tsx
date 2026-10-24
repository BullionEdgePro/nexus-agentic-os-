"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { getTeamUnread } from "@/lib/api";
import { useTeamSocket, type TeamSocketEvent } from "@/lib/use-team-socket";
import "./team-chat-alerts.css";

/**
 * Team chat on every signed-in screen (24 Oct 2026): the unread count beside
 * "Team chat" in the sidebar, and a small alert when someone @mentions you.
 *
 * The count is the server's (GET /api/team-chat/unread), re-read when a team
 * event arrives, when the Team chat page marks something read, and every
 * minute — so it agrees across tabs and devices.
 */
const UNREAD_EVENT = "nexus:team-unread";

export function TeamChatBadge() {
  const [counts, setCounts] = useState<{ unread: number; mentioned: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      getTeamUnread()
        .then((next) => {
          if (!cancelled) setCounts(next);
        })
        .catch(() => undefined);
    void refresh();
    const timer = setInterval(refresh, 60_000);
    window.addEventListener(UNREAD_EVENT, refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener(UNREAD_EVENT, refresh);
    };
  }, []);

  if (!counts || counts.unread === 0) return null;
  return (
    <span
      className={`rail-badge${counts.mentioned > 0 ? " hot" : ""}`}
      aria-label={`${counts.unread} unread team ${counts.unread === 1 ? "message" : "messages"}`}
    >
      {counts.unread > 99 ? "99+" : counts.unread}
    </span>
  );
}

export function TeamChatAlerts({ employeeId }: { employeeId: string | null }) {
  const pathname = usePathname();
  const [toast, setToast] = useState<{ author: string; threadId: string } | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const onEvent = useCallback(
    (event: TeamSocketEvent) => {
      // Typing changes no count; re-reading the badge on every keystroke would
      // ask the server every 3 seconds per person typing.
      if (event.type === "team_typing") return;
      window.dispatchEvent(new Event(UNREAD_EVENT));
      const message = event.message;
      if (
        event.type === "team_message" &&
        message &&
        employeeId &&
        message.mentions.includes(employeeId) &&
        message.authorEmployeeId !== employeeId &&
        !pathname.startsWith("/deck/team-chat")
      ) {
        setToast({ author: message.authorName, threadId: event.threadId });
        if (hide.current) clearTimeout(hide.current);
        hide.current = setTimeout(() => setToast(null), 12_000);
      }
    },
    [employeeId, pathname]
  );
  const onReconnect = useCallback(() => window.dispatchEvent(new Event(UNREAD_EVENT)), []);
  useTeamSocket(null, onEvent, onReconnect);

  if (!toast) return null;
  return (
    <div className="tc-toast" role="status">
      <span>
        <b>{toast.author}</b> mentioned you in Team chat.
      </span>
      <a href="/deck/team-chat">Open</a>
      <button type="button" aria-label="Dismiss" onClick={() => setToast(null)}>
        ×
      </button>
    </div>
  );
}
