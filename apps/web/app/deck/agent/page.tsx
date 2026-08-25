"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getAgentConfig,
  readableError,
  updateOrganizationSettings,
  setSystemPrompt,
  type AgentConfigView,
  type KeywordCollision,
  type OrganizationSettings,
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
  const [settings, setSettings] = useState<OrganizationSettings | null>(null);
  const [collisions, setCollisions] = useState<KeywordCollision[]>([]);
  /** The keyword list as text, one per line, which is how a person edits a list. */
  const [keywords, setKeywords] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);

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
      setSettings(data.settings);
      setCollisions(data.collisions);
      setKeywords((data.settings?.routingKeywords ?? []).join("\n"));
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

  async function saveRouting() {
    if (!settings) return;
    const next = keywords
      .split(/[\n,]/)
      .map((word) => word.trim())
      .filter(Boolean);

    setSavingSettings(true);
    setError("");
    setSaved("");
    try {
      const data = await updateOrganizationSettings(business, { routingKeywords: next });
      setSettings(data.settings);
      setCollisions(data.collisions);
      setKeywords(data.settings.routingKeywords.join("\n"));
      setSaved("Saved. The routing menu offers this business on those words from the next message.");
    } catch (err) {
      setError(readableError(err, "Those keywords could not be saved."));
    } finally {
      setSavingSettings(false);
    }
  }

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
            {settings ? (
              <section className="ag-routing">
                <h2>How customers reach this business</h2>
                <p className="ag-note">
                  Five businesses answer on one WhatsApp number. When somebody messages it, these
                  words are how the platform works out which of them they want — and a business
                  with none is left off the menu entirely.
                </p>

                {/* THE COLLISIONS, which nothing anywhere could show before.
                    A word claimed by two firms is a tie the classifier breaks
                    on a rule neither of them chose, and two of the businesses
                    on this number are competing law practices. */}
                {collisions.length > 0 ? (
                  <div className="ag-collisions">
                    <strong>
                      {collisions.length === 1
                        ? "1 of these words is also claimed by another business here"
                        : `${collisions.length} of these words are also claimed by other businesses here`}
                    </strong>
                    <ul>
                      {collisions.map((clash) => (
                        <li key={`${clash.keyword}-${clash.withSlug}`}>
                          <code>{clash.keyword}</code> — also {clash.withName}
                        </li>
                      ))}
                    </ul>
                    <span>
                      Not an error: two businesses really can both do the same thing. But whoever
                      owns both lists should decide which keeps the word, rather than the
                      classifier deciding it on their behalf.
                    </span>
                  </div>
                ) : null}

                <textarea
                  className="ag-keywords"
                  value={keywords}
                  onChange={(event) => setKeywords(event.target.value)}
                  rows={6}
                  spellCheck={false}
                  placeholder={"attestation\nnotary\ncertificate"}
                />
                <div className="ag-bar">
                  <span className="ag-count">
                    {keywords.split(/[\n,]/).filter((w) => w.trim()).length} words
                  </span>
                  <button
                    type="button"
                    className="ag-save"
                    disabled={savingSettings}
                    onClick={() => void saveRouting()}
                  >
                    {savingSettings ? "Saving…" : "Save keywords"}
                  </button>
                  <span className="ag-meta">
                    {settings.timezone}
                    {settings.whatsappDisplayNumber ? ` · ${settings.whatsappDisplayNumber}` : ""}
                  </span>
                </div>
              </section>
            ) : null}

            <h2 className="ag-section">What the agent is told to be</h2>
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
