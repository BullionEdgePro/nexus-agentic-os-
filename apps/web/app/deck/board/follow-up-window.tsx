"use client";

import { useState } from "react";
import type { TaskRecord } from "@/lib/api";
import { CardWindow } from "../../kit/card-window";
import { COLUMNS, columnFor, whenLabel, type ColumnKey } from "./columns";

/**
 * A follow-up opened from its card (2 Nov 2026, Cream pages 2a): what it is,
 * who it is for and when, and the three things anybody does with one — finish
 * it, go to the chat it came from, or move it. Move to is also the keyboard's
 * way to do what a drag does, and the way for anybody who cannot drag.
 *
 * It stays open after an action and shows the follow-up as the server now has
 * it, rather than closing on a card that has just moved columns and taking the
 * keyboard's place with it. If the follow-up disappears while it is open — a
 * reload without it, a filter — it says so instead of acting on a stale copy.
 */
export function FollowUpWindow({
  task,
  onClose,
  onMove,
  onDone,
  origin,
}: {
  task: TaskRecord | null;
  onClose: () => void;
  onMove: (to: Exclude<ColumnKey, "done">) => Promise<void>;
  onDone: () => Promise<void>;
  origin: HTMLElement | null;
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  async function run(action: () => Promise<void>, saved: string) {
    setBusy(true);
    setNote("");
    try {
      await action();
      setNote(saved);
    } catch (err) {
      // The page has already put the server's reason into words.
      setNote(err instanceof Error && err.message ? err.message : "That change could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  if (!task) {
    return (
      <CardWindow open title="Follow-up" onClose={onClose} origin={origin}>
        <h2>Follow-up</h2>
        <p>This follow-up is gone.</p>
        <div className="kit-actions">
          <button type="button" className="kit-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </CardWindow>
    );
  }

  const open = task.status === "open";
  const here = columnFor(task);
  const elsewhere = COLUMNS.filter((c) => c.key !== "done" && c.key !== here) as Array<{
    key: Exclude<ColumnKey, "done">;
    label: string;
  }>;

  return (
    <CardWindow open title={task.title} onClose={onClose} origin={origin}>
      <h2 dir="auto">{task.title}</h2>
      <dl className="kit-rows">
        <dt>Customer</dt>
        <dd dir="auto">{task.contactName ?? "—"}</dd>
        <dt>Business</dt>
        <dd dir="auto">{task.businessName}</dd>
        <dt>Who has it</dt>
        <dd dir="auto">{task.employeeName ?? "nobody yet"}</dd>
        <dt>Due</dt>
        <dd>{whenLabel(task)}</dd>
        {open ? null : (
          <>
            <dt>Closed</dt>
            <dd dir="auto">
              {task.status === "done"
                ? task.completedByName
                  ? `Done by ${task.completedByName}`
                  : "Done"
                : "Cancelled"}
            </dd>
          </>
        )}
        {task.notes ? (
          <>
            <dt>Notes</dt>
            <dd dir="auto">{task.notes}</dd>
          </>
        ) : null}
      </dl>

      <div className="kit-actions">
        {open ? (
          <button type="button" className="kit-btn" disabled={busy} onClick={() => void run(onDone, "Marked done.")}>
            Mark done
          </button>
        ) : null}
        {task.conversationId ? (
          <a className="kit-btn quiet" href={`/inbox?conversation=${encodeURIComponent(task.conversationId)}`}>
            Open chat
          </a>
        ) : null}
      </div>

      {open ? (
        <div className="kit-actions fu-move" role="group" aria-labelledby="fu-move-label">
          <span id="fu-move-label" className="fu-move-label">
            Move to
          </span>
          {elsewhere.map((c) => (
            <button
              key={c.key}
              type="button"
              className="kit-btn quiet"
              aria-label={`Move to ${c.label}`}
              disabled={busy}
              onClick={() => void run(() => onMove(c.key), `Moved to ${c.label}.`)}
            >
              {c.label}
            </button>
          ))}
        </div>
      ) : null}

      <p className="fu-note" role="status">
        {note}
      </p>
    </CardWindow>
  );
}
