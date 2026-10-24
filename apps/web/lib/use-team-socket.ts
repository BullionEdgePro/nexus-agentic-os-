"use client";

import { useEffect, useRef, useState } from "react";
import type { TeamChatMessage } from "./api";

/** What the API publishes on /ws/team (apps/api/src/lib/team-events.ts). */
export interface TeamSocketEvent {
  type: "team_message" | "team_message_removed" | "team_read" | "team_typing";
  organizationId: string;
  organizationSlug: string;
  threadId: string;
  kind: "room" | "direct";
  members: string[];
  message?: TeamChatMessage;
  reader?: string;
  /** The typer's name, for team_typing. */
  name?: string;
}

export type TeamSocketStatus = "off" | "connecting" | "open" | "closed";

/**
 * The live team chat stream (24 Oct 2026).
 *
 * The same server and address as the inbox stream, on its own path, so a team
 * message never rides the inbox feed. The server decides what this socket
 * hears from the session; `org` only narrows the admin's view to one business.
 *
 * `onReconnect` fires when a connection comes back after dropping: the screen
 * re-reads then, so nothing said while it was offline is lost.
 */
export function useTeamSocket(
  org: string | null,
  onEvent: (event: TeamSocketEvent) => void,
  onReconnect: () => void
): TeamSocketStatus {
  const [status, setStatus] = useState<TeamSocketStatus>("connecting");
  const eventRef = useRef(onEvent);
  const reconnectRef = useRef(onReconnect);
  eventRef.current = onEvent;
  reconnectRef.current = onReconnect;

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_WS_URL;
    if (!base) {
      setStatus("off");
      return;
    }
    const url = `${base.replace(/\/ws\/?$/, "")}/ws/team${org ? `?org=${encodeURIComponent(org)}` : ""}`;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelayMs = 1000;
    let droppedOnce = false;

    function connect() {
      setStatus("connecting");
      socket = new WebSocket(url);
      socket.onopen = () => {
        retryDelayMs = 1000;
        if (cancelled) return;
        setStatus("open");
        if (droppedOnce) reconnectRef.current();
      };
      socket.onmessage = (frame) => {
        try {
          eventRef.current(JSON.parse(frame.data) as TeamSocketEvent);
        } catch {
          // A malformed frame is dropped; the next re-read covers it.
        }
      };
      socket.onclose = () => {
        if (cancelled) return;
        droppedOnce = true;
        setStatus("closed");
        retryTimer = setTimeout(connect, retryDelayMs);
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      };
    }

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      socket?.close();
    };
  }, [org]);

  return status;
}
