"use client";

import { useEffect, useState } from "react";
import {
  getConversationDetails,
  updateConversationDetails,
  setConversationCollaborators,
  assignConversation,
  readableError,
  type ConversationDetails,
  type StaffRef,
} from "@/lib/api";
import { useInboxStore } from "@/lib/store";

const LEAD_STAGES = ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"];

/**
 * The right-hand Details panel — who this customer is, and the fields a
 * colleague keeps on them.
 *
 * Loaded per conversation in one request, then edited in place. Text fields
 * (lead stage, notes) save when they lose focus; the stage chips and custom
 * fields save on the click that changes them. Every save adopts the server's
 * normalised result, so what is on screen is always what was stored.
 */
export function DetailsPanel({ conversationId }: { conversationId: string }) {
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
    try {
      await assignConversation(conversationId, employeeId);
      setError(null);
    } catch (err) {
      setDetails((d) => (d ? { ...d, assignedEmployeeId: prevId, assignedEmployeeName: prevName } : d));
      applyAssignment(conversationId, prevId);
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

  async function save(patch: { leadStage?: string | null; notes?: string | null; customFields?: Record<string, string> }) {
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

  if (error) return <p className="dp-empty">{error}</p>;
  if (!details) return <p className="dp-empty">Loading…</p>;

  return (
    <div className="dp">
      <section className="dp-block">
        <h3 className="dp-name">{details.contactName ?? details.contactWaId}</h3>
        <dl className="dp-facts">
          <div>
            <dt>WhatsApp</dt>
            <dd>+{details.contactWaId}</dd>
          </div>
          <div>
            <dt>First seen</dt>
            <dd>{details.firstSeenAt ? new Date(details.firstSeenAt).toLocaleDateString() : "—"}</dd>
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
            "Mine". The options are the serving business's staff (the set the API
            accepts); "Unassigned" hands it back to no one in particular. */}
        <select
          className="dp-assign"
          value={details.assignedEmployeeId ?? ""}
          onChange={(e) => void assign(e.target.value || null)}
          aria-label="Assign this conversation to a staff member"
        >
          <option value="">Unassigned</option>
          {/* The current assignee may be inactive, or from before a routing
              change, and so absent from the list — keep them selectable so their
              name shows instead of the box silently reading "Unassigned". */}
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
          // Only people not already on the thread and not the owner (they are on
          // it by assignment). An empty picker means everyone is already here.
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
          {LEAD_STAGES.map((s) => (
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
        <h4 className="dp-h">Notes</h4>
        <textarea
          className="dp-notes"
          defaultValue={details.notes ?? ""}
          key={`notes-${conversationId}`}
          rows={4}
          placeholder="Internal notes on this customer — never sent to them."
          onBlur={(e) => {
            const v = e.target.value;
            if (v !== (details.notes ?? "")) void save({ notes: v });
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
              onChange={(e) =>
                setFields((f) => f.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
              }
              onBlur={() => saveFields(fields)}
            />
            <input
              className="dp-field-v"
              value={row.value}
              placeholder="Value"
              onChange={(e) =>
                setFields((f) => f.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)))
              }
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
        <button
          type="button"
          className="dp-add"
          onClick={() => setFields((f) => [...f, { key: "", value: "" }])}
        >
          + Add field
        </button>
      </section>
    </div>
  );
}
