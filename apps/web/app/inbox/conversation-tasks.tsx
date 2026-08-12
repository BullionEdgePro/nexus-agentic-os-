"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getConversationTasks,
  createConversationTask,
  updateTask,
  type TaskRecord,
} from "@/lib/api";

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

  const load = useCallback(async () => {
    try {
      const data = await getConversationTasks(conversationId);
      setTasks(data.tasks);
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
    void load();
  }, [load]);

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
      setError(err instanceof Error ? err.message : "Could not save that follow-up.");
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
      setError(err instanceof Error ? err.message : "Could not close that follow-up.");
    }
  }

  return (
    <div className="mb-3 border-b border-neutral-800 pb-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
          Follow-ups
          {outstanding.length > 0 ? (
            <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300">
              {outstanding.length}
            </span>
          ) : null}
        </h2>
        <button
          onClick={() => setOpen((was) => !was)}
          className="text-xs text-neutral-400 hover:text-white"
        >
          {open ? "Cancel" : "+ Add"}
        </button>
      </div>

      {outstanding.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {outstanding.map((task) => (
            <li
              key={task.id}
              className={`flex items-start justify-between gap-3 rounded px-2 py-1.5 text-sm ${
                task.isOverdue ? "bg-red-500/10" : "bg-neutral-900"
              }`}
            >
              <div className="min-w-0">
                <p className="truncate">{task.title}</p>
                <p className="text-[11px] text-neutral-500">
                  {task.employeeName ?? "nobody's job"}
                  {task.dueAt ? (
                    <span className={task.isOverdue ? "ml-2 text-red-400" : "ml-2"}>
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
              <button
                onClick={() => complete(task)}
                className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
              >
                Done
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {open ? (
        <form onSubmit={add} className="mt-2 flex flex-wrap gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing after this conversation?"
            maxLength={200}
            autoFocus
            className="min-w-0 flex-1 rounded bg-neutral-900 px-3 py-2 text-sm outline-none placeholder:text-neutral-600"
          />
          <input
            type="datetime-local"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            className="rounded bg-neutral-900 px-2 py-2 text-sm text-neutral-300 outline-none"
          />
          <button
            type="submit"
            disabled={busy || !title.trim()}
            className="rounded bg-blue-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
          >
            {busy ? "Saving…" : "Add"}
          </button>
        </form>
      ) : null}

      {error ? <p className="mt-2 text-xs text-red-400">{error}</p> : null}
    </div>
  );
}
