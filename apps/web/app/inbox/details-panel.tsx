"use client";

import { useEffect, useState } from "react";
import {
  getConversationDetails,
  updateConversationDetails,
  setConversationCollaborators,
  assignConversation,
  getConversationNotes,
  addConversationNote,
  deleteConversationNote,
  readableError,
  type ConversationDetails,
  type ConversationNote,
  type StaffRef,
} from "@/lib/api";
import { useInboxStore } from "@/lib/store";
import { CallLogPanel } from "./call-log";

type Tab = "details" | "calls" | "notes";

/** How the customer is reached, labelled for the channel they are on. */
function contactLine(d: ConversationDetails): { label: string; value: string } {
  switch (d.channel) {
    case "facebook":
      return { label: "Messenger", value: "Facebook Page conversation" };
    case "instagram":
      return { label: "Instagram", value: "Instagram DM" };
    case "email":
      return { label: "Email", value: "Email thread" };
    default:
      return { label: "WhatsApp", value: d.contactWaId ? `+${d.contactWaId}` : "—" };
  }
}

function when(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

/**
 * The right-hand panel — who this customer is, what has been done, and what the
 * team knows — as three tabs: Details, Calls, Notes.
 *
 * Loaded per conversation in one request, then edited in place. Text fields save
 * when they lose focus; the stage chips and custom fields save on the click that
 * changes them. Every save adopts the server's normalised result, so what is on
 * screen is always what was stored.
 */
export function DetailsPanel({ conversationId }: { conversationId: string }) {
  const [tab, setTab] = useState<Tab>("details");
  const [details, setDetails] = useState<ConversationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<{ key: string; value: string }[]>([]);
  const [collaborators, setCollaborators] = useState<StaffRef[]>([]);
  const [team, setTeam] = useState<StaffRef[]>([]);
  // The staff this thread can be assigned to — the serving business's team, the
  // exact set the assign endpoint accepts.
  const [assignable, setAssignable] = useState<StaffRef[]>([]);
  // Keep the loaded list's "Mine" folder and counts in step when we reassign.
  const applyAssignment = useInboxStore((s) => s.applyAssignment);
  const applyAssigneeName = useInboxStore((s) => s.applyAssigneeName);
  const refreshTimeline = useInboxStore((s) => s.refreshTimeline);
  // The business's own pipeline stages (Settings), in pipeline order.
  const stages = useInboxStore((s) => s.inboxSettings.stages);

  useEffect(() => {
    let live = true;
    setDetails(null);
    setError(null);
    getConversationDetails(conversationId)
      .then((res) => {
        if (!live) return;
        setDetails(res.details);
        setCollaborators(res.collaborators);
        setTeam(res.team);
        setAssignable(res.assignableTeam ?? []);
        setFields(Object.entries(res.details.customFields).map(([key, value]) => ({ key, value })));
      })
      .catch((err) => live && setError(readableError(err, "Could not load these details.")));
    return () => {
      live = false;
    };
  }, [conversationId]);

  // Assign or hand back (employeeId null). Optimistic on both the panel and the
  // inbox list; on failure the previous assignee goes back, because a picker that
  // shows a change that did not save is the assignment version of a send that
  // silently failed.
  async function assign(employeeId: string | null) {
    if (!details) return;
    const prevId = details.assignedEmployeeId;
    const prevName = details.assignedEmployeeName;
    const chosen = employeeId ? assignable.find((t) => t.id === employeeId) ?? null : null;
    setDetails((d) => (d ? { ...d, assignedEmployeeId: employeeId, assignedEmployeeName: chosen?.name ?? null } : d));
    applyAssignment(conversationId, employeeId);
    applyAssigneeName(conversationId, chosen?.name ?? null);
    try {
      await assignConversation(conversationId, employeeId);
      setError(null);
      void refreshTimeline(conversationId);
    } catch (err) {
      setDetails((d) => (d ? { ...d, assignedEmployeeId: prevId, assignedEmployeeName: prevName } : d));
      applyAssignment(conversationId, prevId);
      applyAssigneeName(conversationId, prevName);
      setError(readableError(err, "Could not change who this is assigned to."));
    }
  }

  async function saveCollaborators(ids: string[]) {
    try {
      const res = await setConversationCollaborators(conversationId, ids);
      setCollaborators(res.collaborators);
      setError(null);
    } catch (err) {
      setError(readableError(err, "Could not update collaborators."));
    }
  }

  async function save(patch: {
    leadStage?: string | null;
    notes?: string | null;
    customFields?: Record<string, string>;
    leadSource?: string | null;
  }) {
    try {
      const { details: next } = await updateConversationDetails(conversationId, patch);
      setDetails(next);
      if (patch.customFields) setFields(Object.entries(next.customFields).map(([key, value]) => ({ key, value })));
      setError(null);
    } catch (err) {
      setError(readableError(err, "That change did not save."));
    }
  }

  const saveFields = (rows: { key: string; value: string }[]) => {
    const map: Record<string, string> = {};
    for (const r of rows) if (r.key.trim()) map[r.key.trim()] = r.value;
    void save({ customFields: map });
  };

  if (!details) return <p className="dp-empty">{error ?? "Loading…"}</p>;

  const reach = contactLine(details);
  // A stage set before the business customised its list stays visible and
  // selectable, rather than silently vanishing from the chips.
  const stageChoices =
    details.leadStage && !stages.includes(details.leadStage) ? [...stages, details.leadStage] : stages;

  return (
    <div className="dp">
      <div className="dp-tabs" role="tablist" aria-label="Customer panel">
        {(["details", "calls", "notes"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={`dp-tab${tab === t ? " on" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "details" ? "Details" : t === "calls" ? "Calls" : "Notes"}
          </button>
        ))}
      </div>

      {error ? <p className="dp-error">{error}</p> : null}

      {tab === "calls" ? (
        <section className="dp-block">
          <p className="dp-hint">
            Calls logged here also appear in the conversation, in order, beside the messages.
          </p>
          <CallLogPanel conversationId={conversationId} onChange={() => void refreshTimeline(conversationId)} />
        </section>
      ) : tab === "notes" ? (
        <NotesTab conversationId={conversationId} details={details} onSaveLegacy={(v) => save({ notes: v })} />
      ) : (
        <>
          <section className="dp-block">
            <h3 className="dp-name">{details.contactName ?? (details.contactWaId ? `+${details.contactWaId}` : "Customer")}</h3>
            <dl className="dp-facts">
              <div>
                <dt>{reach.label}</dt>
                <dd>{reach.value}</dd>
              </div>
              <div>
                <dt>First seen</dt>
                <dd>{details.firstSeenAt ? new Date(details.firstSeenAt).toLocaleDateString() : "—"}</dd>
              </div>
              <div>
                <dt>Last from them</dt>
                <dd>{when(details.lastInboundAt)}</dd>
              </div>
              <div>
                <dt>Last from us</dt>
                <dd>{when(details.lastOutboundAt)}</dd>
              </div>
              <div>
                <dt>Marketing</dt>
                <dd className={details.optedOut ? "dp-out" : "dp-in"}>
                  {details.optedOut ? "Opted out" : "Opted in"}
                </dd>
              </div>
            </dl>
          </section>

          <section className="dp-block">
            <h4 className="dp-h">Assigned to</h4>
            {/* Who owns this thread — the one control that puts it in a person's
                "Mine". The options are the serving business's staff (the set the
                API accepts); "Unassigned" hands it back to no one in particular. */}
            <select
              className="dp-assign"
              value={details.assignedEmployeeId ?? ""}
              onChange={(e) => void assign(e.target.value || null)}
              aria-label="Assign this conversation to a staff member"
            >
              <option value="">Unassigned</option>
              {details.assignedEmployeeId && !assignable.some((t) => t.id === details.assignedEmployeeId) ? (
                <option value={details.assignedEmployeeId}>
                  {details.assignedEmployeeName ?? "Current assignee"}
                </option>
              ) : null}
              {assignable.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            {assignable.length === 0 ? (
              <p className="dp-collab-none">This business has no staff to assign yet.</p>
            ) : null}
          </section>

          <section className="dp-block">
            <h4 className="dp-h">Collaborators</h4>
            {collaborators.length ? (
              <div className="dp-collabs">
                {collaborators.map((p) => (
                  <span key={p.id} className="dp-collab">
                    {p.name}
                    <button
                      type="button"
                      className="dp-collab-x"
                      aria-label={`Remove ${p.name}`}
                      onClick={() => saveCollaborators(collaborators.filter((c) => c.id !== p.id).map((c) => c.id))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <p className="dp-collab-none">Nobody extra on this thread.</p>
            )}
            {(() => {
              const addable = team.filter(
                (t) => !collaborators.some((c) => c.id === t.id) && t.id !== details.assignedEmployeeId
              );
              return addable.length ? (
                <select
                  className="dp-collab-add"
                  value=""
                  onChange={(e) => {
                    const id = e.target.value;
                    if (id) saveCollaborators([...collaborators.map((c) => c.id), id]);
                  }}
                  aria-label="Add a collaborator"
                >
                  <option value="">+ Add colleague…</option>
                  {addable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              ) : null;
            })()}
          </section>

          <section className="dp-block">
            <h4 className="dp-h">Lead status</h4>
            <div className="dp-stages">
              {stageChoices.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`dp-stage${details.leadStage === s ? " on" : ""}`}
                  onClick={() => save({ leadStage: details.leadStage === s ? null : s })}
                >
                  {s}
                </button>
              ))}
            </div>
            {details.leadPriority || details.leadScore != null ? (
              <p className="dp-ai">
                AI read: {details.leadPriority ?? "—"}
                {details.leadScore != null ? ` · score ${details.leadScore}` : ""}
              </p>
            ) : null}
          </section>

          <section className="dp-block">
            <h4 className="dp-h">Lead source</h4>
            <input
              className="dp-source"
              defaultValue={details.leadSource ?? ""}
              key={`source-${conversationId}-${details.leadSource ?? ""}`}
              placeholder="Where they came from — Instagram ad, referral, walk-in…"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (details.leadSource ?? "")) void save({ leadSource: v || null });
              }}
            />
          </section>

          <section className="dp-block">
            <h4 className="dp-h">Custom fields</h4>
            {fields.map((row, i) => (
              <div className="dp-field" key={i}>
                <input
                  className="dp-field-k"
                  value={row.key}
                  placeholder="Field"
                  onChange={(e) => setFields((f) => f.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))}
                  onBlur={() => saveFields(fields)}
                />
                <input
                  className="dp-field-v"
                  value={row.value}
                  placeholder="Value"
                  onChange={(e) => setFields((f) => f.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))}
                  onBlur={() => saveFields(fields)}
                />
                <button
                  type="button"
                  className="dp-field-x"
                  aria-label="Remove field"
                  onClick={() => {
                    const next = fields.filter((_, j) => j !== i);
                    setFields(next);
                    saveFields(next);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="dp-add" onClick={() => setFields((f) => [...f, { key: "", value: "" }])}>
              + Add field
            </button>
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Internal notes as a timeline — who wrote what, and when. Never sent to the
 * customer. The older single "notes" field (one box, last save wins) stays
 * editable at the top as the customer's pinned note, so nothing written there
 * before is lost.
 */
function NotesTab({
  conversationId,
  details,
  onSaveLegacy,
}: {
  conversationId: string;
  details: ConversationDetails;
  onSaveLegacy: (v: string) => void;
}) {
  const [notes, setNotes] = useState<ConversationNote[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    setNotes(null);
    getConversationNotes(conversationId)
      .then((res) => live && setNotes(res.notes))
      .catch((err) => {
        if (!live) return;
        setNotes([]);
        setError(readableError(err, "Could not load the notes."));
      });
    return () => {
      live = false;
    };
  }, [conversationId]);

  async function add() {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError("");
    try {
      const { note } = await addConversationNote(conversationId, body);
      setNotes((xs) => [note, ...(xs ?? [])]);
      setDraft("");
    } catch (err) {
      setError(readableError(err, "That note did not save."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    const previous = notes;
    setNotes((xs) => (xs ?? []).filter((n) => n.id !== id));
    try {
      await deleteConversationNote(conversationId, id);
    } catch (err) {
      setNotes(previous);
      setError(readableError(err, "Could not delete that note."));
    }
  }

  return (
    <section className="dp-block">
      <h4 className="dp-h">Pinned note</h4>
      <textarea
        className="dp-notes"
        defaultValue={details.notes ?? ""}
        key={`notes-${conversationId}`}
        rows={2}
        placeholder="One line the whole team should see first — never sent to the customer."
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== (details.notes ?? "")) onSaveLegacy(v);
        }}
      />

      <h4 className="dp-h dp-h-gap">Team notes</h4>
      <textarea
        className="dp-notes"
        rows={3}
        value={draft}
        placeholder="Add a note for your colleagues — what you found out, what you promised…"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void add();
          }
        }}
      />
      <button type="button" className="dp-add" disabled={busy || !draft.trim()} onClick={() => void add()}>
        {busy ? "Saving…" : "Add note"}
      </button>
      {error ? <p className="dp-error">{error}</p> : null}

      {notes === null ? (
        <p className="dp-collab-none">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="dp-collab-none">No team notes yet.</p>
      ) : (
        <ul className="dp-notelist">
          {notes.map((n) => (
            <li key={n.id} className="dp-note">
              <div className="dp-note-meta">
                <strong>{n.authorName ?? "A colleague"}</strong>
                <span>{when(n.createdAt)}</span>
                <button
                  type="button"
                  className="dp-collab-x"
                  aria-label="Delete note"
                  title="Delete (only your own notes)"
                  onClick={() => void remove(n.id)}
                >
                  ×
                </button>
              </div>
              <p className="dp-note-body">{n.body}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
