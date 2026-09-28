"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getConversationTasks,
  createConversationTask,
  understandFollowUp,
  updateTask,
  type TaskRecord, readableError } from "@/lib/api";

/**
 * Follow-ups, where they are actually noticed.
 *
 * The Follow-ups page is where a list gets managed. This is where one gets
 * CREATED — reading the conversation, at the moment the promise is made. Without
 * it the feature has a door nobody can open: an operator would have to leave
 * the inbox, open another page, re-choose the business and retype the
 * customer's name, and the resulting task would not be linked to anything.
 *
 * WHY THERE IS NO OWNER PICKER HERE. Assigning needs the conversation's serving
 * business, and this pane does not know it. The inbox knows which business it
 * is FILTERED to, which on a shared number is not the same thing — every
 * conversation is owned by the number's owner while the enquiry may have been
 * routed elsewhere. Offering the filtered business's staff would produce a list
 * of the wrong people, and the API would reject the pick. So the server derives
 * the business from the conversation (see createTask), and this stays to one
 * line: what needs doing, and optionally when.
 *
 * A task raised here has no owner and says so — it lands in the "nobody's job"
 * count on the Follow-ups page, which is where it gets one. Visibly unassigned
 * beats silently assigned to a guess.
 */
export function ConversationTasks({ conversationId }: { conversationId: string }) {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  // Said the way a person says it, read back before anything is saved.
  const [spoken, setSpoken] = useState("");
  const [thinking, setThinking] = useState(false);
  const [understood, setUnderstood] = useState<{ title: string; dueAt: string | null; dateDropped: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getConversationTasks(conversationId);
      // `?? []` because the catch below only covers a fetch that FAILED. A 200
      // carrying an unexpected shape sets state to undefined, and the next line
      // of this component does tasks.filter(...) -- which throws during render
      // and takes the whole inbox down, conversation and all.
      //
      // That is the exact outcome the comment below rules out, arriving through
      // the one door the try/catch does not cover. Found when a stubbed reply
      // returned the wrong payload for this URL: the messages vanished, the
      // list vanished, and the screen went white.
      setTasks(data.tasks ?? []);
    } catch {
      // Silent. A failed follow-up fetch must not put an error banner over a
      // live customer conversation — the messages are what this screen is for.
      setTasks([]);
    }
  }, [conversationId]);

  useEffect(() => {
    setTitle("");
    setDue("");
    setError("");
    setSpoken("");
    setUnderstood(null);
    void load();
  }, [load]);

  /*
   * "Call him back Thursday 3pm about the quote" → a title and a time, shown
   * back for a yes. Nothing is filed until the person confirms what was read:
   * a reminder the assistant guessed and saved unseen is a wrong promise on the
   * board that nobody agreed to.
   */
  async function understand(event: React.FormEvent) {
    event.preventDefault();
    if (!spoken.trim()) return;
    setThinking(true);
    setError("");
    try {
      const res = await understandFollowUp(conversationId, spoken.trim());
      setUnderstood({ title: res.title, dueAt: res.dueAt, dateDropped: res.dateDropped });
    } catch (err) {
      setError(readableError(err, "Could not read that — add it by hand below."));
    } finally {
      setThinking(false);
    }
  }

  async function confirmUnderstood() {
    if (!understood) return;
    setBusy(true);
    setError("");
    try {
      await createConversationTask(conversationId, { title: understood.title, dueAt: understood.dueAt });
      setUnderstood(null);
      setSpoken("");
      await load();
    } catch (err) {
      setError(readableError(err, "Could not save that follow-up."));
    } finally {
      setBusy(false);
    }
  }

  // Hand the reading to the manual form to adjust — the datetime-local box
  // wants the reader's own wall clock, which is what new Date() formats into.
  function editUnderstood() {
    if (!understood) return;
    setTitle(understood.title);
    if (understood.dueAt) {
      const d = new Date(understood.dueAt);
      const pad = (n: number) => String(n).padStart(2, "0");
      setDue(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    } else {
      setDue("");
    }
    setUnderstood(null);
    setOpen(true);
  }

  const outstanding = tasks.filter((task) => task.status === "open");

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError("");
    try {
      await createConversationTask(conversationId, {
        title: title.trim(),
        // datetime-local has no zone. Sent raw, Postgres reads it as UTC —
        // four hours off in Dubai, so a 4pm callback looks on time until 8pm.
        dueAt: due ? new Date(due).toISOString() : null,
      });
      setTitle("");
      setDue("");
      setOpen(false);
      await load();
    } catch (err) {
      setError(readableError(err, "Could not save that follow-up."));
    } finally {
      setBusy(false);
    }
  }

  async function complete(task: TaskRecord) {
    setError("");
    try {
      await updateTask(task.id, { status: "done" });
      await load();
    } catch (err) {
      setError(readableError(err, "Could not close that follow-up."));
    }
  }

  return (
    <div className="ibx-card ibx-fu">
      <div className="ibx-fu-head">
        <h4 className="dp-h">
          Follow-ups
          {outstanding.length > 0 ? <span className="ibx-fu-n">{outstanding.length}</span> : null}
        </h4>
        <button type="button" onClick={() => setOpen((was) => !was)} className="ibx-fu-toggle">
          {open ? "Cancel" : "+ Add"}
        </button>
      </div>

      <form className="ibx-fu-say" onSubmit={understand}>
        <input
          value={spoken}
          onChange={(e) => setSpoken(e.target.value)}
          placeholder="Just say it — “call back Thursday 3pm about the quote”"
          maxLength={300}
          aria-label="Describe a follow-up in your own words"
          className="ibx-fu-say-input"
        />
        <button type="submit" className="ibx-fu-say-go" disabled={thinking || !spoken.trim()} title="Read it">
          {thinking ? "…" : "✨"}
        </button>
      </form>

      {understood ? (
        <div className="ibx-fu-read" role="status">
          <p className="ibx-fu-read-title">{understood.title}</p>
          <p className="ibx-fu-read-when">
            {understood.dueAt
              ? new Date(understood.dueAt).toLocaleString(undefined, {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : understood.dateDropped
                ? "That time has passed or could not be read — add a date, or save it undated."
                : "No date"}
          </p>
          <div className="ibx-fu-read-actions">
            <button type="button" className="ibx-fu-save" onClick={() => void confirmUnderstood()} disabled={busy}>
              {busy ? "Saving…" : "Add follow-up"}
            </button>
            <button type="button" className="ibx-fu-toggle" onClick={editUnderstood}>
              Edit
            </button>
            <button type="button" className="ibx-fu-toggle" onClick={() => setUnderstood(null)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      {outstanding.length > 0 ? (
        <ul className="ibx-fu-list">
          {outstanding.map((task) => (
            <li key={task.id} className={`ibx-fu-item${task.isOverdue ? " late" : ""}`}>
              <div className="ibx-fu-main">
                <p className="ibx-fu-title">{task.title}</p>
                <p className="ibx-fu-meta">
                  {task.employeeName ?? "nobody's job"}
                  {task.dueAt ? (
                    <span className={task.isOverdue ? "ibx-fu-due late" : "ibx-fu-due"}>
                      {/* Lateness comes from the server, never from this clock. */}
                      {task.isOverdue ? "was due " : "due "}
                      {new Date(task.dueAt).toLocaleString(undefined, {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  ) : null}
                </p>
              </div>
              <button type="button" onClick={() => complete(task)} className="ibx-fu-done">
                Done
              </button>
            </li>
          ))}
        </ul>
      ) : !open && !understood ? (
        <p className="dp-collab-none">Nothing promised yet. Say it above, or add it by hand.</p>
      ) : null}

      {open ? (
        <form onSubmit={add} className="ibx-fu-form">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing after this conversation?"
            maxLength={200}
            autoFocus
            className="ibx-fu-input"
          />
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="ibx-fu-input"
            aria-label="Due"
          />
          <button type="submit" disabled={busy || !title.trim()} className="ibx-fu-save">
            {busy ? "Saving…" : "Add follow-up"}
          </button>
        </form>
      ) : null}

      {error ? <p className="dp-error">{error}</p> : null}
    </div>
  );
}
