"use client";

import { useEffect, useState } from "react";
import { PhoneAlerts } from "../phone-alerts";
import { fontVariables } from "@/lib/fonts";
import { getMe, readableError, type Me } from "@/lib/api";
import "../deck.css";
import "../activity/activity.css";
import "../my-settings/my-settings.css";
import "../phone-alerts.css";

/**
 * Phone notifications for whoever is signed in (phone push, 4 Nov 2026; mobile
 * plan Task 11). Staff get their own chats; an admin also gets the choice of
 * hearing every new chat nobody has taken. The server holds the same line, so
 * the role here only decides which choices are offered. Staff also have this
 * panel in My settings.
 */
export default function NotificationsPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    getMe()
      .then(setMe)
      .catch((err) => setLoadError(readableError(err, "Could not load your notifications.")));
  }, []);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">
        <header className="act-head">
          <h1>Notifications</h1>
        </header>
        <p className="act-lede">
          Alerts on your phone or computer. Turn them on in each place you want them — on an iPhone, add Nexus to
          your Home Screen first.
        </p>
        <div className="set-grid">
          {me ? (
            <PhoneAlerts role={me.role === "employee" ? "employee" : "operator"} />
          ) : loadError ? (
            <p className="set-error">{loadError}</p>
          ) : (
            <p className="set-hint">Loading…</p>
          )}
        </div>
      </div>
    </div>
  );
}
