"use client";

import { PhoneAlerts } from "../phone-alerts";
import { fontVariables } from "@/lib/fonts";
import "../deck.css";
import "../activity/activity.css";
import "../my-settings/my-settings.css";
import "../phone-alerts.css";

/**
 * An admin's phone notifications (phone push, 4 Nov 2026; mobile plan Task 11).
 * Staff turn theirs on in My settings; an admin has no staff profile there, so
 * the same panel lives here, with the admins' extra choice of hearing every new
 * chat nobody has taken.
 */
export default function NotificationsPage() {
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
          <PhoneAlerts role="operator" />
        </div>
      </div>
    </div>
  );
}
