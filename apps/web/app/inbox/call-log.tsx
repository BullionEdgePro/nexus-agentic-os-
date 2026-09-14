"use client";

import { useCallback, useEffect, useState } from "react";
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
 * The platform cannot place a call — that needs a telephony provider nobody has
 * wired in — so this panel is deliberately honest about what it is: a record of
 * a call that already happened, kept by hand. When a provider is added later it
 * writes the same rows automatically and this panel shows them unchanged.
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

export function CallLogPanel({ conversationId }: { conversationId: string }) {
  const [calls, setCalls] = useState<CallLog[]>([]);
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState<CallDirection>("outbound");
  const [outcome, setOutcome] = useState<CallOutcome>("answered");
  const [minutes, setMinutes] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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
    void load();
  }, [load]);

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
      await load();
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

      {open ? (
        <div className="ibx-call-form">
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
                onChange={(e) => setMinutes(e.target.value)}
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
            <button type="button" className="ibx-ai-btn" onClick={() => setOpen(false)}>
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
