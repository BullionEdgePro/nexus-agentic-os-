"use client";

/**
 * Connecting one person's calendar.
 *
 * ============================================================
 * WHAT THIS SCREEN IS CAREFUL ABOUT
 * ============================================================
 *
 * The link is a credential. It goes in and never comes back out — the server
 * returns the HOST and not the URL, so the field is always empty on load rather
 * than pre-filled with the previous value. That is the opposite of what a
 * settings form usually does, and it is deliberate: rendering it back would put
 * bearer access to somebody's diary into any screenshot of this page.
 *
 * The other care is about what a green tick would mean. A calendar that synced
 * successfully and whose feed contains eleven monthly recurrences is NOT fully
 * understood, and saying "connected" full stop would be a small lie with a real
 * consequence — the person looks free on the one day a month they are not. So
 * the unsupported count is shown beside the connection rather than logged.
 */

import { useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  connectCalendar,
  disconnectCalendar,
  readableError,
  type CalendarRecord,
} from "../../../lib/api";

function when(iso: string | null): string {
  if (!iso) return "not yet";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "not yet";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function CalendarLink({
  business,
  employeeId,
  calendar,
  onChanged,
}: {
  business: BusinessSlug;
  employeeId: string;
  calendar: CalendarRecord | null;
  onChanged: () => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    try {
      await connectCalendar(business, employeeId, url.trim());
      setUrl("");
      onChanged();
    } catch (err) {
      setError(readableError(err, "That calendar could not be connected."));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError("");
    try {
      await disconnectCalendar(business, employeeId);
      onChanged();
    } catch (err) {
      setError(readableError(err, "That calendar could not be disconnected."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cal">
      <div className="cal-head">
        <h4>Calendar</h4>
        <p>
          A rota says when someone is meant to be here. A calendar says whether they are free right
          now — so the agent stops offering somebody who is in a meeting.
        </p>
      </div>

      {error ? <p className="cal-err">{error}</p> : null}

      {calendar ? (
        <div className="cal-on">
          <p className="cal-state">
            <span className="cal-host">{calendar.host}</span>
            <span>
              {calendar.busyBlocks} {calendar.busyBlocks === 1 ? "block" : "blocks"} · checked{" "}
              {when(calendar.lastSyncedAt)}
            </span>
          </p>

          {/* A failure that leaves the previous answer standing, said in those
              words. Somebody reading "last checked 4h ago" with no explanation
              would reasonably assume the sync is simply slow. */}
          {calendar.lastError ? (
            <p className="cal-warn">
              Last check failed: {calendar.lastError} The times below are from before that and are
              still being used.
            </p>
          ) : null}

          {/* Not a footnote. This is the difference between "your calendar is
              synced" and "your calendar is synced except for the parts that
              repeat monthly", and only one of those is safe to rely on. */}
          {calendar.unsupportedCount > 0 ? (
            <p className="cal-warn">
              {calendar.unsupportedCount}{" "}
              {calendar.unsupportedCount === 1 ? "event repeats" : "events repeat"} monthly or
              yearly. Those repeats are not read, so those times are not blocked.
            </p>
          ) : null}

          <button type="button" className="cal-off" onClick={() => void remove()} disabled={busy}>
            {busy ? "…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="cal-add">
          <label>
            <span>Secret iCal address</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
              // Never `type="url"`: a webcal:// address is what Apple and
              // Outlook put on the clipboard, and the browser would refuse it
              // before the server got the chance to rewrite it.
              type="text"
              autoComplete="off"
            />
          </label>
          <p className="cal-hint">
            In Google Calendar: Settings → the calendar → <em>Secret address in iCal format</em>.
            Only free/busy times are read; nothing is ever written back. Anyone with this link can
            read the calendar, so treat it like a password.
          </p>
          <button
            type="button"
            className="cal-save"
            onClick={() => void save()}
            disabled={busy || !url.trim()}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      )}
    </div>
  );
}
