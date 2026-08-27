"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BusinessTabs, useVisibleBusinesses } from "@/lib/business-tabs";
import type { BusinessSlug } from "@nexus/shared";
import {
  getTasks,
  createTask,
  updateTask,
  getTeam,
  type TaskRecord,
  type TaskCounts,
  type TaskStatus,
  type TeamMember, readableError } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "./tasks.css";

/**
 * Follow-ups — what a conversation left someone to do.
 *
 * The platform could already tell you what was said and what was promised. It
 * could not tell you what anyone still owed a customer, because that lived in
 * whoever's head took the conversation. This is that list.
 *
 * Two decisions worth naming, because both look like omissions:
 *
 * OVERDUE COMES FROM THE SERVER. `isOverdue` is computed by Postgres against
 * its own clock and is never recomputed here from `dueAt`. The browser's clock
 * belongs to whichever laptop is open — an hour fast and this page invents a
 * column of emergencies, an hour slow and it hides the one thing that is late.
 *
 * UNASSIGNED IS SHOWN, NOT HIDDEN. A task with nobody's name on it is the most
 * likely thing on the page to never happen, so it gets a flag rather than a
 * blank cell.
 */
export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [counts, setCounts] = useState<TaskCounts>({ open: 0, overdue: 0, unassigned: 0 });
  const [business, setBusiness] = useState<BusinessSlug | "">("");
  const [status, setStatus] = useState<TaskStatus | "all">("open");
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [error, setError] = useState("");
  /**
   * A LOAD that failed, kept apart from an ACTION that failed.
   *
   * The render below refuses to draw anything when this is set, because the
   * alternative is the previous business's numbers under the new one's name.
   * An action failure — a recompute, a send, a save — must NOT do that: the
   * screen it happened on is still correct, and blanking it would lose the
   * context the message is about.
   */
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const { businesses: visibleBusinesses } = useVisibleBusinesses();
  const [draftBusiness, setDraftBusiness] = useState<BusinessSlug | "">("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftNotes, setDraftNotes] = useState("");
  const [draftDue, setDraftDue] = useState("");
  const [draftOwner, setDraftOwner] = useState("");

  const load = useCallback(async (slug: BusinessSlug | "", which: TaskStatus | "all") => {
    setLoading(true);
    setError("");
    setLoadError("");
    try {
      const data = await getTasks({ business: slug, status: which });
      setTasks(data.tasks);
      setCounts(data.counts);
    } catch (err) {
      setLoadError(readableError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business, status);
  }, [business, status, load]);

  // The assignee list has to come from the business the task is FOR, not the
  // one being viewed — otherwise picking "SFS" in the form while filtered to
  // "all" offers a list of nobody, and the field looks broken.
  useEffect(() => {
    if (!draftBusiness) {
      setTeam([]);
      return;
    }
    let cancelled = false;
    getTeam(draftBusiness)
      .then((data) => {
        if (!cancelled) setTeam(data.employees.filter((member) => member.isActive));
      })
      .catch(() => {
        // A failed team fetch must not block the form. The task can be created
        // unassigned and handed to someone afterwards.
        if (!cancelled) setTeam([]);
      });
    return () => {
      cancelled = true;
    };
  }, [draftBusiness]);

  // Clear a stale owner when the business changes: the API refuses an employee
  // from another company, so leaving the previous pick selected would produce a
  // rejection the operator cannot see the cause of.
  useEffect(() => {
    setDraftOwner("");
  }, [draftBusiness]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draftTitle.trim() || !draftBusiness) return;
    setSaving(true);
    setError("");
    try {
      await createTask({
        business: draftBusiness,
        title: draftTitle,
        notes: draftNotes || null,
        // datetime-local yields "2026-08-14T16:00" with no zone. Sent as-is the
        // server would read it as UTC — four hours out in Dubai, so a 4pm
        // callback would sit on the list looking on time until 8pm. Converting
        // through Date attaches the operator's actual offset.
        dueAt: draftDue ? new Date(draftDue).toISOString() : null,
        employeeId: draftOwner || null,
      });
      setDraftTitle("");
      setDraftNotes("");
      setDraftDue("");
      setDraftOwner("");
      await load(business, status);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSaving(false);
    }
  }

  async function change(task: TaskRecord, next: TaskStatus) {
    setError("");
    try {
      await updateTask(task.id, { status: next });
      await load(business, status);
    } catch (err) {
      setError(readableError(err));
    }
  }

  const heading = useMemo(() => {
    if (counts.open === 0) return "Nothing outstanding";
    if (counts.overdue > 0) return `${counts.overdue} overdue`;
    return `${counts.open} open`;
  }, [counts]);

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">

        <header className="act-head">
          <h1>Follow-ups</h1>
        </header>
        <p className="act-lede">
          What a conversation left someone to do. The handover brief says what the agent already
          promised a customer; this is the record of who is going to do something about it, and by
          when.
        </p>

        <div className="tk-counts">
          <div className="tk-count">
            <strong>{counts.open}</strong>
            <span>open</span>
          </div>
          <div className={`tk-count${counts.overdue > 0 ? " bad" : ""}`}>
            <strong>{counts.overdue}</strong>
            <span>overdue</span>
          </div>
          <div className={`tk-count${counts.unassigned > 0 ? " warn" : ""}`}>
            <strong>{counts.unassigned}</strong>
            <span>nobody&apos;s job</span>
          </div>
        </div>

        <form className="tk-new" onSubmit={submit}>
          <h2 className="act-sub-head">Add a follow-up</h2>
          <div className="tk-row">
            <label>
              <span>Business</span>
              <select
                value={draftBusiness}
                onChange={(e) => setDraftBusiness(e.target.value as BusinessSlug | "")}
                required
              >
                <option value="">Choose…</option>
                {/* SCOPED LIKE THE TABS ABOVE. A dropdown is a switcher wearing
                    a different hat: an employee offered five businesses here
                    can pick one the create call then refuses, and the follow-up
                    they were writing is lost to a 403 they cannot read. */}
                {visibleBusinesses.map((tenant) => (
                  <option key={tenant.slug} value={tenant.slug}>
                    {tenant.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="tk-grow">
              <span>What needs doing</span>
              <input
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Call Mr Haddad back about the attestation quote"
                maxLength={200}
                required
              />
            </label>
          </div>
          <div className="tk-row">
            <label>
              <span>Due</span>
              <input type="datetime-local" value={draftDue} onChange={(e) => setDraftDue(e.target.value)} />
            </label>
            <label>
              <span>Owner</span>
              <select value={draftOwner} onChange={(e) => setDraftOwner(e.target.value)}>
                <option value="">
                  {draftBusiness
                    ? team.length === 0
                      ? "No staff on this business yet"
                      : "Nobody yet"
                    : "Choose a business first"}
                </option>
                {team.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="tk-grow">
              <span>Notes</span>
              <input
                value={draftNotes}
                onChange={(e) => setDraftNotes(e.target.value)}
                placeholder="Optional — the detail that would not fit above"
              />
            </label>
          </div>
          <button type="submit" disabled={saving || !draftTitle.trim() || !draftBusiness}>
            {saving ? "Saving…" : "Add follow-up"}
          </button>
        </form>

        <BusinessTabs
          value={business}
          onChange={(slug) => setBusiness(slug)}
        />

        {loadError ? (
          /*
           * WHEN THE LOAD FAILS, NOTHING BELOW IS DRAWN.
           *
           * This line used to appear ABOVE the data, and the data was
           * whatever the last successful load had put in state. Switch
           * business, have the request fail, and this page showed the
           * PREVIOUS business's numbers under the new one's name — one
           * tenant's figures attributed to another, arriving through the
           * UI rather than the database that spent a whole feature
           * preventing exactly that.
           *
           * Clearing the data instead would have been worse: the page
           * would fall through to its empty state and say "nothing to
           * report" when the truth is "nobody could ask". Those are the
           * two silences the operators panel was fixed for this morning.
           */
          <p className="act-msg">{loadError}</p>
        ) : null}

        <h2 className="act-sub-head">{heading}</h2>

        {loadError ? null : loading ? (
          <div className="act-empty">Loading…</div>
        ) : tasks.length === 0 ? (
          <div className="act-empty">
            <strong>Nothing here.</strong>
            <br />
            {status === "open"
              ? "No outstanding follow-ups for this selection."
              : "No follow-ups match this filter."}
          </div>
        ) : (
          <ul className="tk-list">
            {tasks.map((task) => (
              <li className={`tk-item${task.isOverdue ? " overdue" : ""}${task.status !== "open" ? " closed" : ""}`} key={task.id}>
                <div className="tk-main">
                  <p className="tk-title">{task.title}</p>
                  {task.notes ? <p className="tk-notes">{task.notes}</p> : null}
                  <p className="tk-meta">
                    <span className="tk-biz">{task.businessName}</span>
                    {task.contactName || task.contactWaId ? (
                      <span>for {task.contactName ?? `+${task.contactWaId}`}</span>
                    ) : null}
                    {task.employeeName ? (
                      <span>{task.employeeName}</span>
                    ) : task.status === "open" ? (
                      <span className="act-flag warn">nobody&apos;s job</span>
                    ) : null}
                    {task.dueAt ? (
                      <span className={task.isOverdue ? "tk-due late" : "tk-due"}>
                        {task.isOverdue ? "was due " : "due "}
                        {formatWhen(task.dueAt)}
                      </span>
                    ) : (
                      <span className="tk-due none">no date</span>
                    )}
                    {task.status === "done" ? (
                      <span className="tk-done-by">
                        done{task.completedByName ? ` by ${task.completedByName}` : " from the deck"}
                      </span>
                    ) : null}
                    {task.status === "cancelled" ? <span className="tk-done-by">cancelled</span> : null}
                  </p>
                </div>
                <div className="tk-actions">
                  {task.status === "open" ? (
                    <>
                      <button onClick={() => change(task, "done")}>Done</button>
                      <button className="quiet" onClick={() => change(task, "cancelled")}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button className="quiet" onClick={() => change(task, "open")}>
                      Reopen
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="act-caveat">
          A follow-up recorded here is a commitment, not a reminder — cancelling keeps the record
          that something was once owed to a customer, which is why nothing on this page deletes.
        </p>
      </div>
    </div>
  );
}

/**
 * Dates are formatted in the operator's own zone, deliberately.
 *
 * The businesses are all in Dubai, so hard-coding Asia/Dubai would be right
 * today and quietly wrong the first time someone reads this page from abroad —
 * and being quietly wrong about a due time is the failure this whole page
 * exists to prevent.
 */
function formatWhen(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
