"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getAgentConfig,
  readableError,
  setSystemPrompt,
  type AgentConfigView,
  type PromptVersion,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "./agent.css";

/**
 * What the agent is told to be.
 *
 * ============================================================
 * THE MOST CONSEQUENTIAL BOX ON THIS DECK
 * ============================================================
 *
 * Every other screen here shapes a reply indirectly. Knowledge supplies facts
 * that may or may not be retrieved. A procedure applies to the situations it
 * matches. A phrase covers one moment. This is the standing instruction
 * underneath all of them, sent with every single message, and until today it
 * could only be changed by running a script on the server.
 *
 * ============================================================
 * WHAT THE SCREEN SAYS OUT LOUD, AND WHY
 * ============================================================
 *
 * That there is no review step. Everything else on this deck that changes what
 * a customer is told has one — a procedure is proposed and activated
 * separately, a phrase is switched on from a screen that shows what else
 * answers that moment. This takes effect on the next message, and a person
 * about to press Save should know that before they press it rather than after.
 *
 * And that a bad prompt does not fail. It answers, plausibly and slightly
 * wrongly, to everyone, until somebody reads a transcript — which is why the
 * history is on the same screen rather than behind a link, and why restoring an
 * old one is a button rather than a copy-paste.
 */
export default function AgentPage() {
  const [business, setBusiness] = useState<BusinessSlug>("zipicka");
  const [config, setConfig] = useState<AgentConfigView | null>(null);
  const [history, setHistory] = useState<PromptVersion[]>([]);
  const [limits, setLimits] = useState({ min: 40, max: 8000 });
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback(async (slug: BusinessSlug) => {
    setLoading(true);
    setLoadError("");
    setError("");
    setSaved("");
    try {
      const data = await getAgentConfig(slug);
      setConfig(data.config);
      setHistory(data.history);
      setLimits(data.limits);
      setDraft(data.config.systemPrompt);
      setNote("");
    } catch (err) {
      setConfig(null);
      setLoadError(readableError(err, "The agent's settings could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business);
  }, [business, load]);

  const changed = config !== null && draft.trim() !== config.systemPrompt.trim();

  async function save() {
    if (!config) return;
    // Asked first, and the question names the consequence rather than the
    // action. "Save changes?" describes a button; this describes what happens.
    const ok = window.confirm(
      `Change what this agent is told to be?\n\n` +
        `Every reply after this one is generated from the new text, starting with the next ` +
        `message. There is no review step. The version being replaced is kept, so you can put ` +
        `it back.`
    );
    if (!ok) return;

    setBusy(true);
    setError("");
    setSaved("");
    try {
      const data = await setSystemPrompt(business, draft, note || undefined);
      setConfig(data.config);
      setHistory(data.history);
      setDraft(data.config.systemPrompt);
      setNote("");
      setSaved("Saved. The next message this business receives is answered from it.");
    } catch (err) {
      setError(readableError(err, "That could not be saved."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">
        <header className="act-head">
          <h1>How the agent behaves</h1>
        </header>
        <p className="act-lede">
          The standing instruction underneath every reply. Knowledge gives it facts and procedures
          cover particular situations — this is what it is told to be the rest of the time.
        </p>

        <div className="act-tabs">
          {TENANTS.map((tenant) => (
            <button
              key={tenant.slug}
              aria-pressed={business === tenant.slug}
              onClick={() => setBusiness(tenant.slug as BusinessSlug)}
            >
              {tenant.ref}
            </button>
          ))}
        </div>

        {loadError ? (
          <p className="ag-err ag-err-load">{loadError}</p>
        ) : loading ? (
          <p className="ag-note">Loading…</p>
        ) : config ? (
          <>
            {/* STATED BEFORE THE BOX, not after the save. Every other screen
                that changes what a customer is told has a review step; this one
                does not, and somebody should know that while they are typing. */}
            <p className="ag-warn">
              There is no review step here. What you save is what the agent is told, from the next
              message onwards.
            </p>

            {error ? <p className="ag-err">{error}</p> : null}
            {saved ? <p className="ag-saved">{saved}</p> : null}

            <textarea
              className="ag-prompt"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={16}
              spellCheck={false}
            />

            <div className="ag-bar">
              <span className={draft.trim().length > limits.max ? "ag-count over" : "ag-count"}>
                {draft.trim().length} / {limits.max}
              </span>
              <input
                className="ag-note-input"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What changed, and why (optional)"
              />
              <button
                type="button"
                className="ag-save"
                // Disabled until it could actually succeed rather than letting
                // somebody press it and be told no — the same standard the
                // broadcast Send button holds itself to.
                disabled={
                  busy ||
                  !changed ||
                  draft.trim().length < limits.min ||
                  draft.trim().length > limits.max
                }
                onClick={() => void save()}
              >
                {busy ? "Saving…" : changed ? "Save" : "No changes"}
              </button>
              {changed ? (
                <button
                  type="button"
                  className="ag-revert"
                  onClick={() => setDraft(config.systemPrompt)}
                >
                  Discard
                </button>
              ) : null}
            </div>

            <p className="ag-meta">
              {config.promptUpdatedBy ? (
                <>
                  Last changed by {config.promptUpdatedBy} · {when(config.promptUpdatedAt)}
                </>
              ) : (
                // A fact rather than a gap: it means nobody has touched this
                // since the business was set up, which is worth knowing.
                <>Never changed since this business was set up.</>
              )}
              {" · "}
              {config.model}
              {config.tools.length > 0 ? <> · {config.tools.join(", ")}</> : null}
            </p>

            {history.length > 0 ? (
              <section className="ag-history">
                <button
                  type="button"
                  className="ag-history-toggle"
                  onClick={() => setShowHistory((v) => !v)}
                  aria-expanded={showHistory}
                >
                  {history.length === 1 ? "1 earlier version" : `${history.length} earlier versions`}
                  <span aria-hidden="true">{showHistory ? " ▾" : " ▸"}</span>
                </button>
                {showHistory ? (
                  <ul className="ag-versions">
                    {history.map((version) => (
                      <li key={version.id}>
                        <p className="ag-version-meta">
                          replaced {when(version.createdAt)}
                          {version.replacedBy ? ` by ${version.replacedBy}` : ""}
                          {version.note ? ` — ${version.note}` : ""}
                        </p>
                        <pre className="ag-version-text">{version.systemPrompt}</pre>
                        {/* Loads it into the box rather than saving it, so
                            putting an old version back goes through the same
                            confirmation as any other change. */}
                        <button
                          type="button"
                          className="ag-restore"
                          onClick={() => setDraft(version.systemPrompt)}
                        >
                          Put this back in the box
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ag-note">
                    Every change keeps what it replaced. A prompt that answers slightly wrongly is
                    not something you notice on the day.
                  </p>
                )}
              </section>
            ) : null}
          </>
        ) : (
          <p className="ag-note">This business has no agent configured.</p>
        )}
      </div>
    </div>
  );
}

function when(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "never";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
