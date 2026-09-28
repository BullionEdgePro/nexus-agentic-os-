"use client";

import { useEffect, useState } from "react";
import type { InboxSocketEvent } from "@nexus/shared";
import "./assignment-alerts.css";

interface Alert {
  key: string;
  conversationId: string;
  contactName: string;
  assignedBy: string;
}

const KEEP_MS = 12_000;

/**
 * "A CHAT IS NOW YOURS" — on every screen a staff member can be on.
 *
 * An assignment used to change a column and nothing else, so a chat given to
 * somebody sat in their inbox until they happened to open it. The server now
 * publishes an "assigned" event on the live inbox stream (services/
 * assignment-alert.ts); this listens on the person's own business channel and
 * reacts only to events naming them.
 *
 * Two surfaces: a pop-up in the corner that links straight to the chat, and a
 * desktop notification when the browser allows it — so a person on another tab
 * hears about it too. Asking for that permission is a button in the pop-up, not
 * a prompt on page load: a browser prompt nobody asked for gets denied, and a
 * denial is permanent.
 *
 * Quiet when the live feed is not configured, and reconnects with backoff like
 * the inbox's own socket.
 */
export function AssignmentAlerts({ employeeId, organizationSlug }: { employeeId: string; organizationSlug: string }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) setPermission(Notification.permission);
  }, []);

  useEffect(() => {
    const baseUrl = process.env.NEXT_PUBLIC_WS_URL;
    if (!baseUrl) return;

    let cancelled = false;
    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retryDelayMs = 1000;

    function connect() {
      socket = new WebSocket(`${baseUrl}?org=${encodeURIComponent(organizationSlug)}`);
      socket.onopen = () => {
        retryDelayMs = 1000;
      };
      socket.onmessage = (event) => {
        let parsed: InboxSocketEvent;
        try {
          parsed = JSON.parse(event.data);
        } catch {
          return;
        }
        if (parsed.type !== "assigned" || parsed.employeeId !== employeeId) return;
        const alert: Alert = {
          key: `${parsed.conversationId}-${Date.now()}`,
          conversationId: parsed.conversationId,
          contactName: parsed.contactName ?? "a customer",
          assignedBy: parsed.assignedBy ?? "A colleague",
        };
        setAlerts((current) => [...current.filter((a) => a.conversationId !== alert.conversationId), alert].slice(-3));
        setTimeout(() => setAlerts((current) => current.filter((a) => a.key !== alert.key)), KEEP_MS);
        notifyDesktop(alert, organizationSlug);
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
  }, [employeeId, organizationSlug]);

  if (alerts.length === 0) return null;

  return (
    <div className="asg-stack" role="status" aria-live="polite">
      {alerts.map((alert) => (
        <div className="asg-card" key={alert.key}>
          <span className="asg-ic" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 5h16v11H8l-4 4V5Z" />
              <path d="M9 10.5h6" />
            </svg>
          </span>
          <div className="asg-body">
            <b>New chat for you</b>
            <span>
              {alert.contactName} · assigned by {alert.assignedBy}
            </span>
            <div className="asg-actions">
              <a
                className="asg-open"
                href={`/inbox?business=${encodeURIComponent(organizationSlug)}&conversation=${encodeURIComponent(alert.conversationId)}`}
              >
                Open chat
              </a>
              {permission === "default" ? (
                <button
                  type="button"
                  className="asg-perm"
                  onClick={() => Notification.requestPermission().then(setPermission).catch(() => undefined)}
                >
                  Alert me on the desktop too
                </button>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            className="asg-x"
            aria-label="Dismiss"
            onClick={() => setAlerts((current) => current.filter((a) => a.key !== alert.key))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function notifyDesktop(alert: Alert, organizationSlug: string) {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    const note = new Notification("New chat for you", {
      body: `${alert.contactName} · assigned by ${alert.assignedBy}`,
      tag: `nexus-assigned-${alert.conversationId}`,
    });
    note.onclick = () => {
      window.focus();
      window.location.href = `/inbox?business=${encodeURIComponent(organizationSlug)}&conversation=${encodeURIComponent(alert.conversationId)}`;
    };
  } catch {
    // Some browsers only allow notifications from a service worker; the pop-up still showed.
  }
}
