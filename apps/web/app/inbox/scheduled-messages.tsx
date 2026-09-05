"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getScheduledMessages,
  scheduleMessage,
  cancelScheduledMessage,
  readableError,
  type ScheduledMessage,
} from "@/lib/api";

/**
 * Scheduled sends on the open conversation — the queue, and the control to add
 * to it.
 *
 * The one inbox action that reaches a customer unattended, so it is built to be
 * seen and undone: every pending send is listed with its time and a Cancel, and
 * scheduling takes the SAME draft the person is already looking at, so there is
 * no second hidden box that could send something they did not read.
 */
export function ScheduledMessages({
  conversationId,
  draft,
  onScheduled,
}: {
  conversationId: string;
  draft: string;
  onScheduled: () => void;
}) {
  const [pending, setPending] = useState<ScheduledMessage[]>([]);
  const [open, setOpen] = useState(false);
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const { scheduled } = await getScheduledMessages(conversationId);
      setPending(scheduled ?? []);
    } catch {
      // A failed load of the schedule must not put a banner over a live
      // conversation; the compose box is what matters.
      setPending([]);
    }
  }, [conversationId]);

  useEffect(() => {
    setOpen(false);
    setWhen("");
    setError("");
    void load();
  }, [load]);

  async function schedule() {
    if (!draft.trim() || !when) return;
    setBusy(true);
    setError("");
    try {
      // datetime-local is zone-less; toISOString reads it in the browser's zone,
      // which is what the person meant by "9am".
      await scheduleMessage(conversationId, draft.trim(), new Date(when).toISOString());
      setOpen(false);
      setWhen("");
      onScheduled();
      await load();
    } catch (err) {
      setError(readableError(err, "Could not schedule that."));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await cancelScheduledMessage(conversationId, id);
      await load();
    } catch (err) {
      setError(readableError(err, "Could not cancel that."));
    }
  }

  return (
    <div className="ibx-sched">
      {pending.length ? (
        <ul className="ibx-sched-list">
          {pending.map((m) => (
            <li key={m.id} className="ibx-sched-item">
              <span className="ibx-sched-when">
                {new Date(m.sendAt).toLocaleString(undefined, {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <span className="ibx-sched-body">{m.body}</span>
              <button type="button" className="ibx-sched-cancel" onClick={() => cancel(m.id)}>
                Cancel
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <div className="ibx-sched-form">
          <input
            type="datetime-local"
            className="ibx-sched-when-input"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            aria-label="When to send"
          />
          <button
            type="button"
            className="ibx-ai-btn"
            disabled={busy || !draft.trim() || !when}
            onClick={schedule}
          >
            {busy ? "Scheduling…" : "Schedule send"}
          </button>
          <button type="button" className="ibx-ai-btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          {!draft.trim() ? <span className="ibx-sched-hint">Type a reply above first.</span> : null}
        </div>
      ) : (
        <button type="button" className="ibx-ai-btn" onClick={() => setOpen(true)}>
          🕓 Schedule for later
        </button>
      )}
      {error ? <p className="ibx-ai-error">{error}</p> : null}
    </div>
  );
}
