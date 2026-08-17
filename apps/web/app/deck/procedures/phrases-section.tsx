"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getPhrases,
  createPhrase,
  updatePhrase,
  unfilledPlaceholders,
  readableError,
  type AgentPhrase,
  type PhraseMoment,
  type PhraseMomentInfo,
} from "@/lib/api";

/**
 * What this business says in its own words (045).
 *
 * Sits under the procedures on the same screen, and the pairing is the whole
 * argument: a procedure is the ORDER the agent works in, this is the WORDS it
 * uses when it stops working and hands over. Both are "how we answer", both are
 * the business's own material, and splitting them across two tabs would have
 * made a person choose between two names for the same question.
 *
 * WHY THIS SECTION IS BLUNTER THAN THE ONE ABOVE IT. A procedure is context the
 * model reads and can work around. A phrase IS the message — sent verbatim, with
 * no model between it and the customer, at the exact moment the platform has
 * already decided it cannot answer properly. There is nothing downstream to
 * catch a mistake in it, so the editor shows the text as it will be sent, warns
 * about placeholders before the server has to refuse, and never lets a switch
 * imply more than it does.
 *
 * The two moments are not editable and not extensible from here on purpose.
 * They are the moments the reply path already detects and already speaks at;
 * wording filed under an invented one would be stored, visible, switched on,
 * and never sent.
 */
export function PhrasesSection({ business }: { business: BusinessSlug }) {
  const [phrases, setPhrases] = useState<AgentPhrase[]>([]);
  const [moments, setMoments] = useState<PhraseMomentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const [newMoment, setNewMoment] = useState<PhraseMoment | "">("");
  const [newBody, setNewBody] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (slug: BusinessSlug) => {
    setLoading(true);
    setError("");
    try {
      const data = await getPhrases(slug);
      setPhrases(data.phrases);
      setMoments(data.moments);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setEditing(null);
    void load(business);
  }, [business, load]);

  async function act(id: string, change: { body?: string; isActive?: boolean }) {
    setBusyId(id);
    setError("");
    try {
      await updatePhrase(business, id, change);
      setEditing(null);
      await load(business);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setBusyId(null);
    }
  }

  async function write(event: React.FormEvent) {
    event.preventDefault();
    if (!newMoment || !newBody.trim()) return;
    setSaving(true);
    setError("");
    try {
      await createPhrase(business, { moment: newMoment, body: newBody });
      setNewBody("");
      setNewMoment("");
      await load(business);
    } catch (err) {
      setError(readableError(err));
    } finally {
      setSaving(false);
    }
  }

  const labelFor = (moment: PhraseMoment) =>
    moments.find((entry) => entry.moment === moment)?.label ?? moment;

  return (
    <section className="ph-root">
      <h2 className="act-sub-head">What we say</h2>
      <p className="act-lede">
        Almost everything a customer reads is written by the agent from what this business knows.
        There are two moments where it is not — where the platform stops and sends a sentence
        somebody wrote. Those sentences are the same for every business on this platform until one
        writes its own, which is why &ldquo;I&apos;m looping in a specialist from our team&rdquo;
        currently goes out over a law firm&apos;s name as readily as a shop&apos;s.
      </p>
      <p className="ph-warn">
        <strong>This text is sent exactly as written.</strong> It is not a hint the agent works
        from — it is the message, delivered at the moment the platform has already admitted it
        cannot answer properly. Nothing checks it afterwards.
      </p>

      {error ? <p className="act-msg">{error}</p> : null}

      {loading ? (
        <div className="act-empty">Loading…</div>
      ) : (
        moments.map((info) => {
          const forMoment = phrases.filter((phrase) => phrase.moment === info.moment);
          const live = forMoment.find((phrase) => phrase.isActive);

          return (
            <article className="ph-moment" key={info.moment}>
              <div className="ph-head">
                <h3>{info.label}</h3>
                <span className={`pr-pill ${live ? "on" : "off"}`}>
                  {live ? "own wording" : "platform default"}
                </span>
              </div>
              <p className="ph-blurb">{info.blurb}</p>

              {forMoment.length === 0 ? (
                // The empty state says what happens NOW, not merely that the
                // list is empty. "Nothing here" and "the platform sentence is
                // going out under your name" are the same state and only one of
                // them is worth reading.
                <p className="ph-default">
                  Nothing written, so the platform&apos;s own sentence is what this business&apos;s
                  customers receive at this moment.
                </p>
              ) : (
                <ul className="ph-list">
                  {forMoment.map((phrase) => {
                    const unfilled = unfilledPlaceholders(phrase.body);
                    const busy = busyId === phrase.id;

                    return (
                      <li className={`ph-item${phrase.isActive ? " on" : ""}`} key={phrase.id}>
                        {editing === phrase.id ? (
                          <>
                            <textarea
                              value={draft}
                              onChange={(event) => setDraft(event.target.value)}
                              rows={4}
                            />
                            {/* Warned before saving rather than after being
                                refused. The person filling in {{open_time}} is
                                looking at the box, not at an error further up. */}
                            {unfilledPlaceholders(draft).length > 0 ? (
                              <p className="ph-placeholder">
                                Still to fill in: {unfilledPlaceholders(draft).join(", ")} — this is
                                sent to the customer exactly as written.
                              </p>
                            ) : null}
                            <div className="ph-actions">
                              <button onClick={() => act(phrase.id, { body: draft })} disabled={busy}>
                                {busy ? "Saving…" : "Save"}
                              </button>
                              <button className="ph-quiet" onClick={() => setEditing(null)}>
                                Cancel
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <p className="ph-body">{phrase.body}</p>
                            {unfilled.length > 0 ? (
                              <p className="ph-placeholder">
                                {unfilled.join(" and ")} has not been filled in, so this cannot be
                                switched on — it would reach the customer exactly like that.
                              </p>
                            ) : null}
                            <div className="ph-meta">
                              <span>
                                {phrase.source === "catalog"
                                  ? "installed from the catalogue"
                                  : "written here"}
                              </span>
                              <div className="ph-actions">
                                <button
                                  className="ph-quiet"
                                  onClick={() => {
                                    setEditing(phrase.id);
                                    setDraft(phrase.body);
                                  }}
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => act(phrase.id, { isActive: !phrase.isActive })}
                                  disabled={busy || (!phrase.isActive && unfilled.length > 0)}
                                >
                                  {busy
                                    ? "Saving…"
                                    : phrase.isActive
                                      ? "Stop sending this"
                                      : "Send this instead"}
                                </button>
                              </div>
                            </div>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </article>
          );
        })
      )}

      <form className="ph-new" onSubmit={write}>
        <h3>Write one</h3>
        <select
          value={newMoment}
          onChange={(event) => setNewMoment(event.target.value as PhraseMoment)}
        >
          <option value="">Which moment…</option>
          {moments.map((info) => (
            <option key={info.moment} value={info.moment}>
              {info.label}
            </option>
          ))}
        </select>
        <textarea
          value={newBody}
          onChange={(event) => setNewBody(event.target.value)}
          rows={4}
          placeholder="The sentence this business sends, in its own voice."
        />
        {newMoment === "no_one_available" ? (
          // Shown against the moment it applies to, at the moment somebody is
          // writing for it. This is the rule an incident was named after and the
          // one most likely to be broken by well-meaning wording.
          <p className="ph-placeholder">
            This one must not promise that anybody will follow up — it is sent precisely when
            nobody is on shift, and the agent keeps answering afterwards.
          </p>
        ) : null}
        <button type="submit" disabled={saving || !newMoment || !newBody.trim()}>
          {saving ? "Saving…" : "Save, switched off"}
        </button>
      </form>
    </section>
  );
}
