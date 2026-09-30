"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCallLogs,
  logCall,
  deleteCallLog,
  readableError,
  type CallLog,
  type CallDirection,
  type CallOutcome,
} from "@/lib/api";

/**
 * The calls logged on the open conversation, and the control to add one.
 *
 * Nexus does not carry the call itself — that needs a telephony provider, or
 * WhatsApp Calling once Meta lifts the number past 2,000 contacts a day. What it
 * does now: the Call button dials the customer from the staff member's own
 * phone (a tel: link — the dialer on a phone, Phone Link or similar on a
 * computer), opens this form already set to Outbound, and times the call. When
 * they come back to Nexus after hanging up, the length is filled in from that
 * timer, so logging it is picking the outcome and pressing Save. When a
 * provider is added later it writes the same rows and this panel is unchanged.
 *
 * A call is not a message, so it is not in the transcript: it has a direction,
 * an outcome and a length, not a body.
 */

const OUTCOMES: { key: CallOutcome; label: string }[] = [
  { key: "answered", label: "Answered" },
  { key: "no-answer", label: "No answer" },
  { key: "voicemail", label: "Voicemail" },
  { key: "busy", label: "Busy" },
  { key: "failed", label: "Failed" },
];

function outcomeLabel(o: CallOutcome): string {
  return OUTCOMES.find((x) => x.key === o)?.label ?? o;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export function CallLogPanel({
  conversationId,
  onChange,
  phone,
  startedAt,
}: {
  conversationId: string;
  /** Told after a call is logged or removed, so the thread timeline can refresh. */
  onChange?: () => void;
  /** The customer's number in international digits, when there is one to dial. */
  phone?: string | null;
  /** Set by the header's Call button: when that call was started (ms). */
  startedAt?: number | null;
}) {
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<CallDirection>("outbound");
  const [outcome, setOutcome] = useState<CallOutcome>("answered");
  const [minutes, setMinutes] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The call in progress, if this panel (or the header) started one.
  const [callStart, setCallStart] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Once the person types a length themselves, the timer stops overwriting it.
  const minutesTouched = useRef(false);

  const load = useCallback(async () => {
    try {
      const { calls } = await getCallLogs(conversationId);
      setCalls(calls ?? []);
    } catch {
      // A failed load of the call history must never put a banner over a live
      // conversation — the transcript and compose box are what matter.
      setCalls([]);
    }
  }, [conversationId]);

  useEffect(() => {
    setOpen(false);
    setDirection("outbound");
    setOutcome("answered");
    setMinutes("");
    setNotes("");
    setError("");
    setCallStart(null);
    minutesTouched.current = false;
    void load();
  }, [load]);

  // A call begun from the header opens the form here, already set up.
  useEffect(() => {
    if (startedAt) beginCall(startedAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt]);

  function beginCall(at: number) {
    setCallStart(at);
    setNow(Date.now());
    setOpen(true);
    setDirection("outbound");
    setOutcome("answered");
    setMinutes("");
    minutesTouched.current = false;
    setError("");
  }

  // While a call is running: tick the timer, and when the person comes back to
  // this tab (they were on the phone), fill in the length from it.
  useEffect(() => {
    if (!callStart) return;
    const fill = () => {
      const t = Date.now();
      setNow(t);
      if (!minutesTouched.current) setMinutes(String(Math.max(1, Math.round((t - callStart) / 60000))));
    };
    const tick = window.setInterval(() => setNow(Date.now()), 15000);
    const onVisible = () => {
      if (document.visibilityState === "visible") fill();
    };
    window.addEventListener("focus", fill);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("focus", fill);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [callStart]);

  async function submit() {
    setBusy(true);
    setError("");
    try {
      // The form asks for whole minutes because that is how a person remembers a
      // call; the API stores seconds, so a call answered for any time at all is
      // at least a few seconds rather than a zero that reads as "never connected".
      const mins = minutes.trim() ? Number(minutes) : NaN;
      const durationSeconds =
        outcome === "answered" && Number.isFinite(mins) && mins >= 0 ? Math.round(mins * 60) : null;
      await logCall(conversationId, {
        direction,
        outcome,
        durationSeconds,
        notes: notes.trim() || null,
      });
      setOpen(false);
      setMinutes("");
      setNotes("");
      setCallStart(null);
      minutesTouched.current = false;
      await load();
      onChange?.();
    } catch (err) {
      setError(readableError(err, "Could not log that call."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await deleteCallLog(conversationId, id);
      await load();
      onChange?.();
    } catch (err) {
      setError(readableError(err, "Could not remove that call log."));
    }
  }

  return (
    <div className="ibx-calls">
      {calls.length ? (
        <ul className="ibx-calls-list">
          {calls.map((call) => (
            <li key={call.id} className={`ibx-call ibx-call-${call.outcome}`}>
              <span className="ibx-call-dir" aria-hidden="true">
                {call.direction === "inbound" ? "↙" : "↗"}
              </span>
              <span className="ibx-call-main">
                <span className="ibx-call-line">
                  <strong>{call.direction === "inbound" ? "Inbound" : "Outbound"}</strong>
                  {" · "}
                  {outcomeLabel(call.outcome)}
                  {call.durationSeconds != null ? ` · ${formatDuration(call.durationSeconds)}` : ""}
                </span>
                <span className="ibx-call-when">
                  {new Date(call.occurredAt).toLocaleString(undefined, {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  {call.loggedBy ? ` · ${call.loggedBy}` : ""}
                </span>
                {call.notes ? <span className="ibx-call-notes">{call.notes}</span> : null}
              </span>
              <button
                type="button"
                className="ibx-call-x"
                aria-label="Remove this call log"
                onClick={() => remove(call.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {phone ? (
        <a className="ibx-call-dial" href={`tel:+${phone}`} onClick={() => beginCall(Date.now())}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 4h3.5l1.5 4-2 1.5a11 11 0 0 0 6.5 6.5l1.5-2 4 1.5V19a1 1 0 0 1-1 1A16 16 0 0 1 4 5a1 1 0 0 1 1-1Z" />
          </svg>
          <span>Call +{phone}</span>
        </a>
      ) : null}

      {open ? (
        <div className="ibx-call-form">
          {callStart ? (
            <p className="ibx-call-live" role="status">
              <span className="ibx-call-pulse" aria-hidden="true" />
              <span>
                Call started {new Date(callStart).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                {now - callStart >= 60000 ? ` · ${Math.round((now - callStart) / 60000)} min ago` : ""}. When you hang
                up, pick how it went and save.
              </span>
            </p>
          ) : null}
          <div className="ibx-call-row">
            <select
              className="ibx-call-select"
              value={direction}
              onChange={(e) => setDirection(e.target.value as CallDirection)}
              aria-label="Call direction"
            >
              <option value="outbound">Outbound</option>
              <option value="inbound">Inbound</option>
            </select>
            <select
              className="ibx-call-select"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as CallOutcome)}
              aria-label="Call outcome"
            >
              {OUTCOMES.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
            {outcome === "answered" ? (
              <input
                className="ibx-call-mins"
                type="number"
                min="0"
                inputMode="numeric"
                value={minutes}
                onChange={(e) => {
                  minutesTouched.current = true;
                  setMinutes(e.target.value);
                }}
                placeholder="min"
                aria-label="Call length in minutes"
              />
            ) : null}
          </div>
          <input
            className="ibx-call-note-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What was said (optional)"
            aria-label="Call notes"
          />
          <div className="ibx-call-row">
            <button type="button" className="ibx-ai-btn" disabled={busy} onClick={submit}>
              {busy ? "Saving…" : "Save call"}
            </button>
            <button
              type="button"
              className="ibx-ai-btn"
              onClick={() => {
                setOpen(false);
                setCallStart(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="ibx-ai-btn" onClick={() => setOpen(true)}>
          📞 Log a call
        </button>
      )}
      {error ? <p className="ibx-ai-error">{error}</p> : null}
    </div>
  );
}
