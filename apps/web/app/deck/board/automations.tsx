"use client";

/**
 * The rules a business has allowed this platform to act on, unattended.
 *
 * ============================================================
 * WHY THIS PANEL SAYS SO MUCH
 * ============================================================
 *
 * Everywhere else on this deck, a screen shows what happened. This one grants
 * permission for something to happen without anybody watching, every ten
 * minutes, for as long as it stays switched on. That is a different kind of
 * control and it is written like one.
 *
 * So: the menu comes from the server's own allow-list rather than from a list
 * typed here — a form that offers an option the create call then refuses was
 * written from memory. Each rule shows how many times it has ACTED, because
 * "on" and "doing something" are different facts and a rule that has never
 * fired is one somebody should probably reconsider. And the sentence under the
 * heading says plainly what the operators do and do not do, because the
 * distinction is the whole design and a person switching this on deserves to
 * know they are not adding a second thing that watches.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  createAutomation,
  deleteAutomation,
  getAutomationOptions,
  getAutomationRuns,
  getAutomations,
  readableError,
  setAutomationActive,
  type AutomationOption,
  type AutomationRecord,
  type AutomationRun,
} from "../../../lib/api";

const readable = (slug: string) => slug.replace(/-/g, " ");

export function Automations({
  business,
  team,
}: {
  business: BusinessSlug | "";
  team: Array<{ id: string; fullName: string }>;
}) {
  const [rules, setRules] = useState<AutomationRecord[]>([]);
  // WHAT THE RULES HAVE ACTUALLY DONE.
  //
  // A rule that has been firing and one that has been REFUSED on every finding
  // look identical in the list below: both show as active, and neither shows a
  // result. `failedReason` is the case that costs somebody real work -- an
  // urgent finding that was meant to be assigned to a person and silently was
  // not.
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [runsReadable, setRunsReadable] = useState<boolean | null>(null);
  const [options, setOptions] = useState<AutomationOption[]>([]);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [open, setOpen] = useState(false);

  const [action, setAction] = useState("");
  const [trigger, setTrigger] = useState("");
  const [assignee, setAssignee] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getAutomations(business);
      setRules(data.automations);
      setLoadError("");
    } catch (err) {
      setLoadError(readableError(err, "The rules could not be loaded."));
    }
  }, [business]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadRuns = useCallback(() => {
    getAutomationRuns(business)
      .then((data) => {
        setRuns(data.runs);
        setRunsReadable(true);
      })
      .catch(() => {
        // An empty history and an unreadable one are opposite news on a panel
        // whose whole subject is whether anything has been happening.
        setRuns([]);
        setRunsReadable(false);
      });
  }, [business]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const failures = useMemo(() => runs.filter((run) => run.failedReason), [runs]);

  useEffect(() => {
    getAutomationOptions()
      .then((data) => setOptions(data.actions))
      .catch(() => undefined);
  }, []);

  const chosen = options.find((o) => o.action === action);

  async function create() {
    setSaving(true);
    setActionError("");
    try {
      await createAutomation({
        business,
        action,
        triggerOperator: trigger,
        assigneeId: chosen?.needsAssignee ? assignee : null,
      });
      setAction("");
      setTrigger("");
      setAssignee("");
      setOpen(false);
      await load();
    } catch (err) {
      setActionError(readableError(err, "That rule could not be created."));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(rule: AutomationRecord) {
    setActionError("");
    try {
      await setAutomationActive(rule.id, !rule.isActive);
      await load();
    } catch (err) {
      setActionError(readableError(err, "That rule could not be changed."));
    }
  }

  async function remove(rule: AutomationRecord) {
    // Asked first, because this takes the record of what it already did with
    // it. Switching off is the reversible one and it is the button beside this.
    const acted = rule.timesRun === 0 ? "" : ` It has acted ${rule.timesRun} time${rule.timesRun === 1 ? "" : "s"}, and that record goes with it.`;
    if (!window.confirm(`Remove this rule?${acted} The follow-ups it raised stay.`)) return;
    setActionError("");
    try {
      await deleteAutomation(rule.id);
      await load();
    } catch (err) {
      setActionError(readableError(err, "That rule could not be removed."));
    }
  }

  return (
    <section className="bd-auto">
      <div className="bd-auto-head">
        <div>
          <h2>Rules</h2>
          <p>
            When one of the checks reports something, do this about it. The checks decide what is
            true — these decide what happens next. Nothing here ever messages a customer.
          </p>
        </div>
        <button type="button" className="bd-auto-add" onClick={() => setOpen((v) => !v)}>
          {open ? "Cancel" : "Add a rule"}
        </button>
      </div>

      {actionError ? <p className="bd-err">{actionError}</p> : null}

      {open ? (
        <div className="bd-auto-form">
          <label>
            <span>Do this</span>
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
                setTrigger("");
              }}
            >
              <option value="">Choose…</option>
              {options.map((o) => (
                <option key={o.action} value={o.action}>
                  {o.describes}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>When this is reported</span>
            <select value={trigger} onChange={(e) => setTrigger(e.target.value)} disabled={!chosen}>
              <option value="">Choose…</option>
              {(chosen?.operators ?? []).map((o) => (
                <option key={o} value={o}>
                  {readable(o)}
                </option>
              ))}
            </select>
          </label>

          {chosen?.needsAssignee ? (
            <label>
              <span>Give it to</span>
              <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
                <option value="">Choose…</option>
                {team.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.fullName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <button
            type="button"
            className="bd-auto-save"
            // Disabled until it could actually succeed, rather than letting
            // somebody press it and be told no — the same standard the Send
            // button on broadcasts holds itself to.
            disabled={saving || !action || !trigger || (chosen?.needsAssignee === true && !assignee)}
            onClick={() => void create()}
          >
            {saving ? "Saving…" : "Switch it on"}
          </button>
        </div>
      ) : null}

      {loadError ? (
        <p className="bd-err">{loadError}</p>
      ) : rules.length === 0 ? (
        <p className="bd-auto-none">
          No rules yet. Everything the checks find waits for a person, which is the default and is
          not a fault.
        </p>
      ) : (
        <ul className="bd-auto-list">
          {rules.map((rule) => (
            <li key={rule.id}>
              <div>
                <p className="bd-auto-what">
                  {readable(rule.triggerOperator)} → {readable(rule.action)}
                  {rule.assigneeName ? ` · ${rule.assigneeName}` : ""}
                </p>
                <p className="bd-auto-meta">
                  {rule.businessName} · {rule.createdBy}
                  {" · "}
                  {/* Acted, not "on". A rule that has never fired is one to
                      reconsider, and a panel that only showed a toggle would
                      hide that. */}
                  {rule.timesRun === 0 ? "has never acted" : `acted ${rule.timesRun}×`}
                </p>
              </div>
              <div className="bd-auto-controls">
                <button
                  type="button"
                  className={rule.isActive ? "bd-auto-on" : "bd-auto-off"}
                  onClick={() => void toggle(rule)}
                >
                  {rule.isActive ? "On" : "Off"}
                </button>
                {/* Not decoration. One rule per business, operator and action is
                    a unique index an inactive rule still holds, so a rule made
                    with the wrong person on it can only be fixed by removing
                    it — and until this existed, creating the corrected one was
                    refused and there was no way out of the dead end. */}
                <button type="button" className="bd-auto-remove" onClick={() => void remove(rule)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ------------------------------------------------------------
          What the rules have done
          ------------------------------------------------------------
          Placed under the rules rather than on its own screen: the question
          "is this working?" is asked while looking at the rule, and a history
          a click away is a history nobody opens. */}
      <div className="bd-runs">
        <h4>
          Recent activity
          {failures.length > 0 ? <em className="bd-runs-bad">{failures.length} refused</em> : null}
        </h4>

        {runsReadable === false ? (
          <p className="bd-runs-empty">
            The history could not be read just now. This is not a report that nothing has run.
          </p>
        ) : runs.length === 0 ? (
          <p className="bd-runs-empty">
            Nothing yet. A rule acts when its trigger next fires — it does not go back over
            findings raised before it existed.
          </p>
        ) : (
          <ul className="bd-runs-list">
            {runs.slice(0, 8).map((run) => (
              <li key={run.id} className={run.failedReason ? "bad" : ""}>
                <span className="bd-run-when">{new Date(run.ranAt).toLocaleString()}</span>
                <span className="bd-run-what">{readable(run.action)}</span>
                {/* The refusal in the rule's own words. A rule that fires and is
                    turned away is the case worth a screen; saying only "failed"
                    would send somebody to read logs for a sentence we already
                    have. */}
                <span className="bd-run-why">{run.failedReason ?? "done"}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
