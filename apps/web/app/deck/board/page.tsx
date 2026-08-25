"use client";

/**
 * The Workspace board: follow-ups arranged by WHEN, not by state.
 *
 * ============================================================
 * WHY THE COLUMNS ARE WHAT THEY ARE
 * ============================================================
 *
 * The obvious kanban here is open / done / cancelled, because those are the
 * three values `tasks.status` can hold. It would also be useless: two of the
 * three are terminal, so every live commitment lands in one pile and the board
 * says exactly what a list already said.
 *
 * A follow-up is a promise with a time on it. "Call them back at 4" is `open`
 * whether it is due in an hour or was due last Tuesday, and the difference
 * between those two is the entire job. So the columns are WHEN — overdue,
 * today, later, and a fourth for what is finished — and dragging a card is a
 * real change to a real field rather than a nicer way to look at the same thing.
 *
 *   Overdue → Today     moves the date to this afternoon
 *   Today   → Later     moves it to tomorrow
 *   anything → Done     completes it, crediting whoever dragged it
 *
 * Nothing drags OUT of Done. Reopening a completed commitment is a different
 * decision from rescheduling a live one — it undoes an accountability record,
 * `completed_by` and all — and it belongs on the list where it can be explained,
 * not on a drag nobody would remember making.
 *
 * ============================================================
 * THE VIEW
 * ============================================================
 *
 * Business and owner, remembered per browser. That is honest rather than
 * ideal: a view stored in localStorage is this machine's view, which is the
 * true meaning of a per-person preference with no per-person storage behind it —
 * the same reasoning the activity bell's `seenAt` records, and the same
 * limitation.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getOrganizations,
  getTasks,
  getTeam,
  readableError,
  updateTask,
  type TaskRecord,
} from "../../../lib/api";
import { Automations } from "./automations";
import { COLUMNS, columnFor, dueDateFor, type ColumnKey } from "./columns";

/** The view this browser last chose. Per machine, which is what localStorage means. */
const VIEW_KEY = "nexus.board.view";
import "./board.css";

function whenLabel(task: TaskRecord): string {
  if (!task.dueAt) return "no date";
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return "no date";
  return due.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function BoardPage() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [businesses, setBusinesses] = useState<Array<{ slug: BusinessSlug; name: string }>>([]);
  const [business, setBusiness] = useState<BusinessSlug | "">("");
  const [owner, setOwner] = useState<"anyone" | "unassigned">("anyone");
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [loading, setLoading] = useState(true);
  const [dragging, setDragging] = useState<string | null>(null);
  const [team, setTeam] = useState<Array<{ id: string; fullName: string }>>([]);
  const [over, setOver] = useState<ColumnKey | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(VIEW_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as { business?: string; owner?: string };
        if (typeof saved.business === "string") setBusiness(saved.business as BusinessSlug | "");
        if (saved.owner === "unassigned") setOwner("unassigned");
      }
    } catch {
      // A corrupt preference is not worth a broken screen.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_KEY, JSON.stringify({ business, owner }));
    } catch {
      // Private browsing. The board still works, it just forgets.
    }
  }, [business, owner]);

  const load = useCallback(async (slug: BusinessSlug | "") => {
    setLoading(true);
    try {
      // "all" rather than "open": the Done column is part of the board, and a
      // board that could not show what was finished today would make every
      // completion look like a card that vanished.
      const data = await getTasks({ business: slug, status: "all" });
      setTasks(data.tasks);
      setLoadError("");
    } catch (err) {
      // A failed LOAD is not a failed ACTION, and this screen keeps them apart
      // for the reason a-failed-load-draws-nothing gives: showing empty columns
      // over a failed fetch says "you have no follow-ups", which is a lie the
      // reader cannot detect.
      setLoadError(readableError(err, "The board could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business);
  }, [business, load]);

  useEffect(() => {
    // Only with a business chosen. `getTeam` is addressed per organization, and
    // "everybody at all five companies" is not a list anybody should be
    // assigning work from — a rule can only give work to somebody at the
    // business it belongs to, and createAutomation refuses otherwise.
    if (!business) {
      setTeam([]);
      return;
    }
    getTeam(business)
      .then((data) => setTeam(data.employees.map((e) => ({ id: e.id, fullName: e.fullName }))))
      .catch(() => setTeam([]));
  }, [business]);

  useEffect(() => {
    getOrganizations()
      .then((data) =>
        setBusinesses(data.organizations.map((o) => ({ slug: o.slug as BusinessSlug, name: o.name })))
      )
      // The switcher degrading to "Every business" is a smaller failure than the
      // board refusing to draw, and the columns below do not depend on it.
      .catch(() => undefined);
  }, []);

  const visible = useMemo(
    () => (owner === "unassigned" ? tasks.filter((t) => !t.employeeId) : tasks),
    [tasks, owner]
  );

  const grouped = useMemo(() => {
    const out: Record<ColumnKey, TaskRecord[]> = { overdue: [], today: [], later: [], done: [] };
    for (const task of visible) out[columnFor(task)].push(task);
    return out;
  }, [visible]);

  async function moveTo(taskId: string, column: ColumnKey) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || columnFor(task) === column) return;

    // Optimistic, then reconciled by the reload below. A card that sits under
    // the cursor for a second before moving reads as a broken drag.
    const previous = tasks;
    setActionError("");
    setTasks((current) =>
      current.map((t) =>
        t.id === taskId
          ? {
              ...t,
              status: column === "done" ? "done" : "open",
              dueAt: column === "done" ? t.dueAt : dueDateFor(column),
              // Kept in step with the optimistic date, because columnFor reads
              // this first. Left alone for Done, which columnFor answers before
              // it looks. The reload below replaces all of it with the server's
              // own verdict a moment later.
              isOverdue: column === "overdue",
            }
          : t
      )
    );

    try {
      if (column === "done") {
        await updateTask(taskId, { status: "done" });
      } else {
        if (task.status !== "open") {
          throw new Error(
            "That follow-up is closed. Reopen it from the list, where the change is explained."
          );
        }
        await updateTask(taskId, { dueAt: dueDateFor(column) });
      }
      await load(business);
    } catch (err) {
      setTasks(previous);
      setActionError(readableError(err, "That change could not be saved."));
    }
  }

  return (
    <div className="bd">
      <header className="bd-head">
        <div>
          <h1>Workspace</h1>
          <p className="bd-sub">
            Every follow-up this platform is holding, by when it is owed. Drag a card to move it.
          </p>
        </div>

        <div className="bd-view">
          <label>
            <span>Business</span>
            <select value={business} onChange={(e) => setBusiness(e.target.value as BusinessSlug | "")}>
              <option value="">Every business</option>
              {businesses.map((b) => (
                <option key={b.slug} value={b.slug}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Owner</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value as "anyone" | "unassigned")}>
              <option value="anyone">Anyone</option>
              <option value="unassigned">Nobody yet</option>
            </select>
          </label>
        </div>
      </header>

      {actionError ? <p className="bd-err">{actionError}</p> : null}

      {loadError ? (
        <p className="bd-err bd-err-load">{loadError}</p>
      ) : loading ? (
        <p className="bd-note">Loading…</p>
      ) : (
        <div className="bd-cols">
          {COLUMNS.map((column) => (
            <section
              key={column.key}
              className={`bd-col${over === column.key ? " over" : ""}`}
              onDragOver={(e) => {
                if (column.key === "done" || dragging) {
                  e.preventDefault();
                  setOver(column.key);
                }
              }}
              onDragLeave={() => setOver((c) => (c === column.key ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                if (dragging) void moveTo(dragging, column.key);
                setDragging(null);
              }}
            >
              <div className="bd-col-head">
                <h2>
                  {column.label}
                  <span className="bd-count">{grouped[column.key].length}</span>
                </h2>
                <p>{column.hint}</p>
              </div>

              <ul>
                {grouped[column.key].map((task) => (
                  <li
                    key={task.id}
                    // Done cards do not drag: reopening is a different decision
                    // from rescheduling and belongs where it can be explained.
                    draggable={task.status === "open"}
                    onDragStart={() => setDragging(task.id)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    className={task.status === "open" ? "bd-card" : "bd-card closed"}
                  >
                    <p className="bd-title">{task.title}</p>
                    <p className="bd-meta">
                      <span>{task.businessName}</span>
                      <span>{task.employeeName ?? "nobody yet"}</span>
                      <span>{whenLabel(task)}</span>
                    </p>
                  </li>
                ))}
                {grouped[column.key].length === 0 ? (
                  <li className="bd-empty">nothing here</li>
                ) : null}
              </ul>
            </section>
          ))}
        </div>
      )}

      {/* Under the board rather than above it: the columns are what somebody
          came here for, and the rules are what they set up once and then leave
          alone. */}
      <Automations business={business} team={team} />
    </div>
  );
}
