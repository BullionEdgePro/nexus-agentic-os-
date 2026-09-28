"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getQuickReplies,
  createQuickReply,
  deleteQuickReply,
  readableError,
  type QuickReply,
} from "@/lib/api";

/**
 * The canned-response picker, in the composer.
 *
 * Staff answer the same handful of questions all day — hours, how to pay, "one
 * moment". This is where a business keeps those answers and drops one into the
 * box in a tap, and where a good reply just typed becomes a saved one. The
 * library is the BUSINESS's (scoped to the selected org), so a new colleague
 * inherits it rather than starting blank.
 *
 * Picking never sends: it fills the draft, for a person to read and send — the
 * same discipline the AI suggest button keeps.
 *
 * SLASH COMMANDS: when the reply box starts with "/", the composer passes what
 * follows as `slashQuery`; the picker opens by itself, filtered to replies whose
 * name or text contains it, and a pick REPLACES the "/…" rather than appending.
 */
export function QuickReplies({
  orgSlug,
  draft,
  onInsert,
  slashQuery = null,
  onReplace,
}: {
  orgSlug: BusinessSlug;
  draft: string;
  onInsert: (body: string) => void;
  slashQuery?: string | null;
  onReplace?: (body: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<QuickReply[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const { quickReplies } = await getQuickReplies(orgSlug);
      setItems(quickReplies);
      setError("");
    } catch (err) {
      // A failed load must not put a banner over a live conversation; the
      // compose box is what matters. The button simply shows no count.
      setError(readableError(err, "Could not load quick replies."));
    }
  }, [orgSlug]);

  useEffect(() => {
    setOpen(false);
    setItems([]);
    void load();
  }, [load]);

  async function saveCurrent() {
    const body = draft.trim();
    if (!body) return;
    const title = window.prompt('Name this quick reply (e.g. "Opening hours")')?.trim();
    if (!title) return;
    setSaving(true);
    setError("");
    try {
      const { quickReply } = await createQuickReply(orgSlug, title, body);
      setItems((xs) => [quickReply, ...xs]);
    } catch (err) {
      setError(readableError(err, "Could not save that reply."));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    // Optimistic: it leaves the list at once, and goes back if the delete fails.
    const previous = items;
    setItems((xs) => xs.filter((x) => x.id !== id));
    try {
      await deleteQuickReply(orgSlug, id);
    } catch (err) {
      setItems(previous);
      setError(readableError(err, "Could not delete that reply."));
    }
  }

  const slashOpen = slashQuery !== null;
  const needle = (slashQuery ?? "").trim().toLowerCase();
  const shown = slashOpen && needle
    ? items.filter((q) => `${q.title} ${q.body}`.toLowerCase().includes(needle))
    : items;
  const isOpen = open || slashOpen;

  function pick(body: string) {
    if (slashOpen && onReplace) onReplace(body);
    else onInsert(body);
    setOpen(false);
  }

  return (
    <div className="ibx-qr">
      <button type="button" className="ibx-ai-btn" onClick={() => setOpen((o) => !o)} aria-expanded={isOpen}>
        💬 Quick replies{items.length ? ` (${items.length})` : ""}
      </button>

      {isOpen ? (
        <div className="ibx-qr-panel" role="menu">
          {slashOpen ? (
            <p className="ibx-qr-hint">
              Quick replies matching <strong>/{slashQuery}</strong> — click one to use it.
            </p>
          ) : null}
          {shown.length === 0 ? (
            <p className="ibx-qr-empty">
              {items.length === 0
                ? "No saved replies yet. Type a message below, then save it as one."
                : "No quick reply matches that — keep typing, or delete the “/”."}
            </p>
          ) : (
            <ul className="ibx-qr-list">
              {shown.map((q) => (
                <li key={q.id} className="ibx-qr-item">
                  <button
                    type="button"
                    className="ibx-qr-pick"
                    title={q.body}
                    onClick={() => pick(q.body)}
                  >
                    <strong>{q.title}</strong>
                    <span>{q.body}</span>
                  </button>
                  <button
                    type="button"
                    className="ibx-qr-del"
                    aria-label={`Delete ${q.title}`}
                    onClick={() => remove(q.id)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {slashOpen ? null : (
            <button
              type="button"
              className="ibx-qr-save"
              disabled={!draft.trim() || saving}
              onClick={saveCurrent}
            >
              {saving ? "Saving…" : "+ Save what's in the box as a quick reply"}
            </button>
          )}
          {error ? <p className="ibx-ai-error">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
