"use client";

import { useEffect } from "react";
import type { InboxSocketEvent } from "@nexus/shared";
import { useInboxStore } from "./store";

/**
 * Connects to the API's live WhatsApp feed, scoped to whichever business is
 * currently selected (?org=<slug>), and reconnects with backoff whenever the
 * selection changes or the socket drops.
 */
export function useInboxSocket(): void {
  const selectedOrg = useInboxStore((s) => s.selectedOrg);
  const appendMessage = useInboxStore((s) => s.appendMessage);
  const applyHandoffChange = useInboxStore((s) => s.applyHandoffChange);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_WS_URL;
    if (!baseUrl) return;

    let retryDelayMs = 1000;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      socket = new WebSocket(`${baseUrl}?org=${selectedOrg}`);

      socket.onmessage = (event) => {
        try {
          const parsed: InboxSocketEvent = JSON.parse(event.data);
          if (parsed.type === "message" && parsed.message) {
            appendMessage(parsed.conversationId, parsed.message);
          } else if (parsed.type === "handoff_changed" && typeof parsed.isHumanHandoff === "boolean") {
            applyHandoffChange(parsed.conversationId, parsed.isHumanHandoff);
          }
        } catch {
          // Ignore malformed frames.
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
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
  }, [selectedOrg, appendMessage, applyHandoffChange]);
}
