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
  const setSocketStatus = useInboxStore((s) => s.setSocketStatus);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_WS_URL;
    if (!baseUrl) {
      // No live feed configured — not a fault, so it must not raise the banner.
      // The list still loads over HTTP; it just will not update on its own.
      setSocketStatus("off");
      return;
    }

    let retryDelayMs = 1000;
    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    function connect() {
      setSocketStatus("connecting");
      socket = new WebSocket(`${baseUrl}?org=${selectedOrg}`);

      socket.onopen = () => {
        // A clean connection resets the backoff, so a link that drops once does
        // not carry a thirty-second delay into its next, unrelated drop.
        retryDelayMs = 1000;
        if (!cancelled) setSocketStatus("open");
      };

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
        // Down and retrying — say so, so a person on the inbox knows a new
        // message may lag rather than trusting a feed that has stopped.
        setSocketStatus("closed");
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
  }, [selectedOrg, appendMessage, applyHandoffChange, setSocketStatus]);
}
