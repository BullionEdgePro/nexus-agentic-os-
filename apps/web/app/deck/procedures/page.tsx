"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getProcedures,
  inferProcedures,
  createProcedure,
  updateProcedure,
  type ProcedureRecord,
  type ProcedureCounts,
  type InferenceReadiness,
  type InferenceRunSummary,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import { PhrasesSection } from "./phrases-section";
import "../deck.css";
import "../activity/activity.css";
import "./procedures.css";

/**
 * How this business answers — the review screen for procedural memory (F10).
 *
 * Every other screen on the deck reports something. This one DECIDES something:
 * switching a procedure on changes the shape of every future reply about that
 * kind of enquiry. So it is built around the decision rather than around the
 * list, and three things follow from that.
 *
 * THE EVIDENCE IS SHOWN WITH ITS LIMITS ATTACHED. "Drawn from 7 conversations
 * the agent handled alone" is what the writer actually knows. It is not proof
 * those seven customers were helped — a customer who gave up leaves the same
 * silence as one who was satisfied — and the caveat at the foot of this page
 * says so in as many words. Removing that sentence would turn a suggestion into
 * a claim the system cannot support.
 *
 * NOTHING IS ON BY DEFAULT AND NOTHING TURNS ITSELF ON. The switch is the whole
 * feature. A screen where the machine's output arrived live and could be turned
 * off afterwards would be a different product with the same name.
 *
 * AN EMPTY SCREEN EXPLAINS ITSELF. Most businesses here will have nothing to
 * review for months. "Nothing yet" and "this cannot work" look identical unless
 * the page says which — the mistake F5 made, wrote down, and this page inherits
 * the fix for.
 */
export default function ProceduresPage() {
  const [business, setBusiness] = useState<BusinessSlug>(TENANTS[0].slug);
  const [procedures, setProcedures] = useState<ProcedureRecord[]>([]);
  const [counts, setCounts] = useState<ProcedureCounts>({ active: 0, drafts: 0, proposals: 0 });
  const [readiness, setReadiness] = useState<InferenceReadiness | null>(null);
  const [intents, setIntents] = useState<string[]>([]);
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
  const [looking, setLooking] = useState(false);
  const [lastRun, setLastRun] = useState<InferenceRunSummary | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const [newIntent, setNewIntent] = useState("");
  const [newSteps, setNewSteps] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (slug: BusinessSlug) => {
    setLoading(true);
    setError("");
    setLoadError("");
    try {
      const data = await getProcedures(slug);
      setProcedures(data.procedures);
      setCounts(data.counts);
      setReadiness(data.readiness);
      setIntents(data.intents);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load procedures.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setLastRun(null);
    setEditing(null);
    void load(business);
  }, [business, load]);

  async function look() {
    setLooking(true);
    setError("");
    try {
      const result = await inferProcedures(business);
      setLastRun(result.summary);
      await load(business);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not look for procedures.");
    } finally {
      setLooking(false);
    }
  }

  async function act(
    id: string,
    change: { isActive?: boolean; steps?: string[]; accept?: boolean; dismiss?: boolean }
  ) {
    setBusyId(id);
    setError("");
    try {
      await updateProcedure(business, id, change);
      setEditing(null);
      await load(business);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update that procedure.");
    } finally {
      setBusyId(null);
    }
  }

  async function write(event: React.FormEvent) {
    event.preventDefault();
    if (!newIntent || !newSteps.trim()) return;
    setSaving(true);
    setError("");
    try {
      await createProcedure(business, {
        intentCategory: newIntent,
        steps: newSteps.split("\n"),
        // Deliberately not activated on creation. Even a procedure somebody
        // wrote themselves is worth reading once more in the shape it will
        // actually take before it starts shaping replies.
        activate: false,
      });
      setNewSteps("");
      setNewIntent("");
      await load(business);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that procedure.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">

        <header className="act-head">
          <h1>How we answer</h1>
        </header>
        <p className="act-lede">
          Knowledge is what a business knows. This is the order it works in — what to establish
          first, then next, then what to offer — and, further down, the words it uses when it stops
          answering and hands over. The platform proposes the order from conversations its agent
          handled without anyone stepping in; nothing here shapes a single reply until somebody
          switches it on.
        </p>

        <div className="act-tabs">
          {TENANTS.map((tenant) => (
            <button
              key={tenant.slug}
              aria-pressed={business === tenant.slug}
              onClick={() => setBusiness(tenant.slug)}
            >
              {tenant.ref}
            </button>
          ))}
        </div>

        <div className="pr-counts">
          <div className={`pr-count${counts.active > 0 ? " live" : ""}`}>
            <strong>{counts.active}</strong>
            <span>shaping replies</span>
          </div>
          <div className="pr-count">
            <strong>{counts.drafts}</strong>
            <span>written, switched off</span>
          </div>
          <div className={`pr-count${counts.proposals > 0 ? " warn" : ""}`}>
            <strong>{counts.proposals}</strong>
            <span>suggested changes</span>
          </div>
        </div>

        <div className="pr-run">
          <button onClick={look} disabled={looking || !readiness?.canRun}>
            {looking ? "Reading conversations…" : "Look for procedures now"}
          </button>
          <span>
            {readiness
              ? `Runs on its own once a day. ${readiness.wellHandled} of ${readiness.conversations} conversations in the last ${readiness.windowDays} days are ones it will learn from.`
              : "Runs on its own once a day."}
          </span>
        </div>

        {/* The result of a run, including the nothing. "Looked at 3 kinds of
            enquiry and wrote nothing" is a result; a button that appears to do
            nothing is a bug report waiting to be filed. */}
        {lastRun ? (
          <p className="pr-result">
            Looked at {lastRun.considered} kind{lastRun.considered === 1 ? "" : "s"} of enquiry —{" "}
            {lastRun.written} written, {lastRun.proposed} change
            {lastRun.proposed === 1 ? "" : "s"} suggested, {lastRun.skipped} left alone.
          </p>
        ) : null}

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

        {readiness?.blockedBecause ? (
          <div className="pr-blocked">
            <strong>Nothing to propose yet.</strong>
            <p>{readiness.blockedBecause}</p>
            {readiness.perIntent.length > 0 ? (
              <ul>
                {readiness.perIntent.map((intent) => (
                  <li key={intent.intent}>
                    <span>{humanise(intent.intent)}</span>
                    <em>
                      {intent.wellHandled}/{readiness.minConversations}
                    </em>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <h2 className="act-sub-head">Procedures</h2>

        {loadError ? null : loading ? (
          <div className="act-empty">Loading…</div>
        ) : procedures.length === 0 ? (
          <div className="act-empty">
            <strong>None stored.</strong>
            <br />
            The agent answers each enquiry on its own merits until one of these exists.
          </div>
        ) : (
          <ul className="pr-list">
            {procedures.map((procedure) => (
              <li
                className={`pr-item${procedure.isActive ? " live" : ""}${
                  procedure.proposedSteps ? " proposed" : ""
                }`}
                key={procedure.id}
              >
                <div className="pr-head">
                  <p className="pr-intent">{humanise(procedure.intentCategory)}</p>
                  <div className="pr-pills">
                    {/* Three sources, three labels. This was a binary — operator
                        or "suggested" — until the catalogue could write one, at
                        which point a pack nobody here wrote would have read as
                        this business's own suggestion. See migration 043. */}
                    <span className={`pr-pill ${procedure.source}`}>
                      {procedure.source === "operator"
                        ? "written here"
                        : procedure.source === "catalog"
                          ? "from the catalogue"
                          : "suggested"}
                    </span>
                    <span className={`pr-pill ${procedure.isActive ? "on" : "off"}`}>
                      {procedure.isActive ? "shaping replies" : "switched off"}
                    </span>
                  </div>
                </div>

                {editing === procedure.id ? (
                  <div className="pr-edit">
                    <label>
                      <span>One step per line</span>
                      <textarea
                        rows={6}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        spellCheck
                      />
                    </label>
                    <p className="pr-edit-note">
                      Saving makes this yours: the nightly writer stops proposing over the top of a
                      procedure a person has written.
                    </p>
                    <div className="pr-actions">
                      <button
                        disabled={busyId === procedure.id || !draft.trim()}
                        onClick={() => act(procedure.id, { steps: draft.split("\n") })}
                      >
                        Save
                      </button>
                      <button className="quiet" onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <ol className="pr-steps">
                    {procedure.steps.map((step, index) => (
                      <li key={index}>{step.text}</li>
                    ))}
                  </ol>
                )}

                {/* A suggested revision to something already live. Shown NEXT TO
                    what is running rather than instead of it — the decision is a
                    comparison, and a screen that shows only the new version asks
                    someone to approve a change they cannot see. */}
                {procedure.proposedSteps ? (
                  <div className="pr-proposal">
                    <p className="pr-proposal-head">
                      The platform now suggests a different order, from{" "}
                      {procedure.derivedFromCount} conversation
                      {procedure.derivedFromCount === 1 ? "" : "s"}
                    </p>
                    <ol className="pr-steps">
                      {procedure.proposedSteps.map((step, index) => (
                        <li key={index}>{step.text}</li>
                      ))}
                    </ol>
                    <div className="pr-actions">
                      <button
                        disabled={busyId === procedure.id}
                        onClick={() => act(procedure.id, { accept: true })}
                      >
                        Use this instead
                      </button>
                      <button
                        className="quiet"
                        disabled={busyId === procedure.id}
                        onClick={() => act(procedure.id, { dismiss: true })}
                      >
                        Keep what we have
                      </button>
                    </div>
                  </div>
                ) : null}

                <p className="pr-meta">
                  {procedure.source === "inferred" ? (
                    <span>
                      from {procedure.derivedFromCount} conversation
                      {procedure.derivedFromCount === 1 ? "" : "s"} the agent handled alone
                    </span>
                  ) : procedure.source === "catalog" ? (
                    // Deliberately NOT "from 0 conversations". A catalogue
                    // procedure has no evidence from this business behind it,
                    // and a zero would read as evidence that came out empty
                    // rather than evidence that was never claimed.
                    <span>installed from the catalogue, not drawn from this business</span>
                  ) : (
                    <span>written by hand</span>
                  )}
                  {/* "ended without a human", never "succeeded" — even though
                      the column is called times_succeeded. It counts
                      conversations where nobody had to step in and the customer
                      kept replying, which is the measurable thing; calling that
                      success would assert exactly what the caveat at the foot of
                      this page says the platform cannot see. */}
                  {procedure.timesApplied > 0 ? (
                    <span>
                      followed on {procedure.timesApplied} conversation
                      {procedure.timesApplied === 1 ? "" : "s"} · {procedure.timesSucceeded} ended
                      without a human
                    </span>
                  ) : procedure.isActive ? (
                    <span>not used yet</span>
                  ) : null}
                  {procedure.reviewedBy ? <span>last decided by {procedure.reviewedBy}</span> : null}
                  {procedure.dismissedAt ? (
                    <span className="pr-dismissed">
                      turned down at {procedure.dismissedEvidence ?? 0} conversations
                    </span>
                  ) : null}
                </p>

                {editing === procedure.id ? null : (
                  <div className="pr-actions">
                    {procedure.isActive ? (
                      <button
                        className="quiet"
                        disabled={busyId === procedure.id}
                        onClick={() => act(procedure.id, { isActive: false })}
                      >
                        Stop using this
                      </button>
                    ) : (
                      <button
                        disabled={busyId === procedure.id}
                        onClick={() => act(procedure.id, { isActive: true })}
                      >
                        Answer this way
                      </button>
                    )}
                    <button
                      className="quiet"
                      onClick={() => {
                        setEditing(procedure.id);
                        setDraft(procedure.steps.map((step) => step.text).join("\n"));
                      }}
                    >
                      Edit
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <form className="pr-new" onSubmit={write}>
          <h2 className="act-sub-head">Write one yourself</h2>
          <p className="pr-new-note">
            The better half of this feature. A procedure someone wrote is authoritative — the
            platform will not propose over the top of it once it is in use.
          </p>
          <label className="pr-field">
            <span>Kind of enquiry</span>
            <select value={newIntent} onChange={(e) => setNewIntent(e.target.value)} required>
              <option value="">Choose…</option>
              {intents.map((intent) => (
                <option key={intent} value={intent}>
                  {humanise(intent)}
                </option>
              ))}
            </select>
          </label>
          <label className="pr-field">
            <span>One step per line</span>
            <textarea
              rows={5}
              value={newSteps}
              onChange={(e) => setNewSteps(e.target.value)}
              placeholder={"Establish which document needs attesting\nAsk which country it is for\nQuote the fee for that pair\nOffer an appointment"}
            />
          </label>
          <button type="submit" disabled={saving || !newIntent || !newSteps.trim()}>
            {saving ? "Saving…" : "Save, switched off"}
          </button>
        </form>

        <p className="act-caveat">
          What the platform can see is that nobody had to step in and the customer kept replying.
          That is not the same as a customer who was helped — someone who gave up leaves the same
          quiet ending — which is why every suggestion here arrives switched off and stays that way
          until a person who knows the business decides otherwise. Nothing on this page deletes: a
          procedure that was once in use is the record of how this business answered for a while.
        </p>

        {/* The order the agent works in, above; the words it uses when it stops
            working, below. Same business, same question, so the same screen. */}
        <PhrasesSection business={business} />
      </div>
    </div>
  );
}

/** `appointment_booking` is a database value; "appointment booking" is English. */
function humanise(intent: string): string {
  const words = intent.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
