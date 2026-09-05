"use client";

import { useEffect, useState } from "react";
import {
  getConversationDetails,
  updateConversationDetails,
  setConversationCollaborators,
  readableError,
  type ConversationDetails,
  type StaffRef,
} from "@/lib/api";

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
        setFields(Object.entries(res.details.customFields).map(([key, value]) => ({ key, value })));
      })
      .catch((err) => live && setError(readableError(err, "Could not load these details.")));
    return () => {
      live = false;
    };
  }, [conversationId]);

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
            <dt>Assigned to</dt>
            <dd>{details.assignedEmployeeName ?? "Unassigned"}</dd>
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
