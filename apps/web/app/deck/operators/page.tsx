"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getFindings,
  dismissFinding,
  restoreFinding,
  type OperatorFinding,
  type OperatorInfo,
} from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "./operators.css";
import { whereToFixIt } from "./where-to-fix-it";

/**
 * What is wrong right now, found without anybody asking.
 *
 * Every other screen on this platform answers a question somebody came here to
 * ask. This one is the answer to a question nobody thought to ask — a customer
 * ignored for three hours, a promise a week past its date, a knowledge source
 * that has been failing to index while the agent kept confidently answering
 * without it.
 *
 * THE EMPTY STATE IS A REAL RESULT, AND IS WRITTEN AS ONE. "Nothing needs
 * attention" from a system that checks every ten minutes is information. Left
 * as a blank panel it would read as "not loaded" or "not working", which is
 * exactly the wrong conclusion to draw from good news — and the reason the
 * roster of what is being watched is listed underneath rather than hidden.
 */
/**
 * How long ago the sweep finished, in words.
 *
 * Deliberately blunt about never having run. "Last checked: never" reads as
 * broken, which it is — the alternative wordings all soften it into something a
 * reader skims past, and this is the one line on the page whose job is to stop
 * an empty list being mistaken for good news.
 */
/**
 * Whether anything on this page reaches a person who is not looking at it.
 *
 * The page already refuses to let an empty list read as good news. This is the
 * same refusal one step out: a fresh sweep and a short list say nothing about
 * whether anybody is TOLD when that list grows at three in the morning.
 *
 * Measured before the dispatcher existed: broken-knowledge stood 4.7 hours on
 * average across twenty-eight findings, and a knowledge outage that took 53 of
 * one firm's 72 passages offline stood for sixteen. Every one of those was
 * detected inside ten minutes and reached nobody.
 *
 * The unconfigured wording is the blunt one, deliberately. "Alerts are off"
 * reads as a setting; "these reach nobody unless somebody opens this page" is
 * the consequence, and the consequence is the part worth acting on.
 */
function describeAlerts(configured: boolean, includeWarnings: boolean): string {
  if (!configured) {
    return "No alert destination is set, so nothing here reaches anybody unless this page is open.";
  }
  return includeWarnings
    ? "Urgent findings and warnings are sent to your alert destination as they appear."
    : "Urgent findings are sent to your alert destination as they appear. Warnings stay on this page.";
}

function describeSweep(lastSweptAt: string | null): string {
  if (!lastSweptAt) return "The sweep has not completed once since the worker started.";
  const minutes = Math.round((Date.now() - new Date(lastSweptAt).getTime()) / 60000);
  if (minutes < 1) return "Checked less than a minute ago.";
  if (minutes < 60) return `Checked ${minutes} minute${minutes === 1 ? "" : "s"} ago.`;
  const hours = Math.round(minutes / 60);
  return `Last checked ${hours} hour${hours === 1 ? "" : "s"} ago.`;
}

export default function OperatorsPage() {
  const [findings, setFindings] = useState<OperatorFinding[]>([]);
  const [operators, setOperators] = useState<OperatorInfo[]>([]);
  const [counts, setCounts] = useState({ urgent: 0, warn: 0, info: 0, dismissed: 0 });
  /** Ids currently being accepted or restored, so a click cannot fire twice. */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** Whether the accepted list is expanded. Collapsed by default, never hidden. */
  const [showDismissed, setShowDismissed] = useState(false);
  const [sweep, setSweep] = useState<{
    lastSweptAt: string | null;
    stalled: boolean;
    alerts: boolean;
    alertsWarn: boolean;
  }>({
    lastSweptAt: null,
    stalled: false,
    alerts: false,
    alertsWarn: false,
  });
  const [business, setBusiness] = useState<BusinessSlug | "">("");
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

  const load = useCallback(async (slug: BusinessSlug | "") => {
    setLoading(true);
    setError("");
    setLoadError("");
    try {
      const data = await getFindings(slug);
      setFindings(data.findings);
      setCounts(data.counts);
      setOperators(data.operators);
      setSweep({
        lastSweptAt: data.lastSweptAt,
        stalled: data.sweepStalled,
        alerts: data.alertsConfigured,
        alertsWarn: data.alertsIncludeWarnings,
      });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load findings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business);
  }, [business, load]);

  /**
   * Accept a finding, or take the acceptance back.
   *
   * RELOADS RATHER THAN PATCHING LOCAL STATE. The counts are computed server
   * side and the severity buckets exclude accepted findings, so mutating the
   * list in place would need this component to reimplement that arithmetic --
   * and a second implementation of "what needs attention" is a second thing to
   * get wrong. The request is cheap and the page is small.
   *
   * A failure sets `error`, not `loadError`: the screen is still correct, and
   * blanking it would lose the finding the message is about.
   */
  const act = useCallback(
    async (finding: OperatorFinding) => {
      const id = finding.id;
      if (busy.has(id)) return;
      setBusy((prev) => new Set(prev).add(id));
      setError("");
      try {
        if (finding.dismissedAt) await restoreFinding(id);
        else await dismissFinding(id);
        await load(business);
      } catch (err) {
        setError(err instanceof Error ? err.message : "That did not go through.");
      } finally {
        setBusy((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    },
    [busy, business, load]
  );

  // The list carries accepted findings too -- the API returns them so this page
  // can say how many there are. Split here rather than server side, because a
  // caller that cannot see them cannot report them, and a page that silently
  // knows about problems it is not mentioning is what this screen exists not
  // to be.
  const active = findings.filter((f) => !f.dismissedAt);
  const dismissed = findings.filter((f) => f.dismissedAt);

  const total = counts.urgent + counts.warn + counts.info;

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root">

        <header className="act-head">
          <h1>Needs attention</h1>
        </header>
        <p className="act-lede">
          Checks that run every ten minutes across every business, whether or not anyone is looking.
          Nothing here calls an AI — these are rules over what the platform already knows.
        </p>

        <div className="act-tabs">
          <button aria-pressed={business === ""} onClick={() => setBusiness("")}>
            All businesses
          </button>
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

        {loadError ? null : loading ? (
          <div className="act-empty">Loading…</div>
        ) : total === 0 ? (
          /*
           * THIS PANEL USED TO ASSERT ITS OWN FRESHNESS.
           *
           * It said "Checked within the last ten minutes" as hardcoded prose. If
           * the sweep stops, `operator_findings` stops changing, the count stays
           * at zero, and that sentence reassures somebody indefinitely — the
           * exact failure migration 050 exists to end, rendered as good news.
           *
           * So an empty list now says WHEN it was last checked, and when nobody
           * has checked it says that instead of claiming otherwise. "Nothing
           * found" and "nothing looked" are different facts and this is the one
           * screen where confusing them costs the most.
           */
          sweep.stalled ? (
            <div className="op-clear stale">
              <strong>Nothing has been checked recently.</strong>
              <p>
                The list below is empty because the sweep is not running, not because there is
                nothing wrong. {describeSweep(sweep.lastSweptAt)} Everything these operators watch
                is currently unwatched.
              </p>
            </div>
          ) : (
            <div className="op-clear">
              <strong>Nothing needs attention.</strong>
              <p>
                No customer is waiting, nothing promised is overdue, and every knowledge source is
                indexing. {describeSweep(sweep.lastSweptAt)}
              </p>
              {/* AN EMPTY LIST BECAUSE THINGS WERE ACCEPTED IS NOT AN EMPTY
                  LIST. Both sentences above are true when the only findings
                  left are ones somebody dismissed -- and stopping there would
                  be this page telling a half-truth about itself, which is the
                  single failure it was built to prevent. Say what is being
                  left out, and where it went. */}
              {counts.dismissed > 0 ? (
                <p className="op-accepted-note">
                  {counts.dismissed === 1
                    ? "One finding is still true and was accepted; it is listed below."
                    : `${counts.dismissed} findings are still true and were accepted; they are listed below.`}
                </p>
              ) : null}
            </div>
          )
        ) : (
          <>
          {/* The list is capped server-side; the counts are not. At 250 open
              findings the page would show 200 and say nothing — a truncation
              that reads as "this is everything". Named rather than hidden,
              because a silent cap on a page whose whole job is "what needs
              attention" is the same failure the page exists to prevent. */}
          {/* Against `active`, not `findings`. The list now carries accepted
              findings too, and `total` counts only what needs attention -- so
              comparing against findings.length would count the accepted ones on
              one side of the inequality and not the other, and the banner would
              stop appearing at exactly the moment the cap started biting. */}
          {total > active.length ? (
            <p className="op-truncated">
              Showing the {active.length} most serious of {total}. The rest are the same
              kinds of thing — clear these and the next ones appear.
            </p>
          ) : null}
          <ul className="op-list">
            {active.map((finding) => (
              <li className={`op-item ${finding.severity}`} key={finding.id}>
                <div className="op-main">
                  {/* THE TITLE IS THE LINK, because the title is what a reader
                      is already looking at when they decide to act. A separate
                      "open" affordance would be one more thing to find on a
                      list whose whole point is being scannable.

                      Not every finding has somewhere useful to go -- see
                      whereToFixIt -- and those stay plain text rather than
                      linking to a page that cannot show the thing. */}
                  {whereToFixIt(finding) ? (
                    <a className="op-title op-link" href={whereToFixIt(finding)!}>
                      {finding.title}
                    </a>
                  ) : (
                    <p className="op-title">{finding.title}</p>
                  )}
                  {finding.detail ? <p className="op-detail">{finding.detail}</p> : null}
                  <p className="op-meta">
                    <span className="op-biz">{finding.businessName}</span>
                    <span>{finding.operator}</span>
                    {/* Age, not timestamp. "Standing for 3 days" is the thing a
                        reader acts on; a date makes them do the arithmetic. */}
                    <span>standing {since(finding.firstSeenAt)}</span>
                  </p>
                </div>
                <div className="op-side">
                  <span className={`op-sev ${finding.severity}`}>{finding.severity}</span>
                  {/* "Accept", not "dismiss" or "ignore".
                      Dismiss suggests the finding goes away; ignore suggests it
                      was never worth raising. Neither is what happens: it stays
                      true, stays reconciled, stays counted, and comes back
                      un-accepted if it lapses and returns. Accept is the only
                      one of the three that describes that. */}
                  <button
                    type="button"
                    className="op-accept"
                    onClick={() => void act(finding)}
                    disabled={busy.has(finding.id)}
                    title="Still true, but you have seen it and it does not need action"
                  >
                    {busy.has(finding.id) ? "…" : "Accept"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          </>
        )}

        {/* ACCEPTED FINDINGS, COLLAPSED BUT NEVER HIDDEN.
            The count is always on screen; only the detail folds away. A screen
            that quietly drops findings somebody accepted last March is how an
            accepted problem becomes a forgotten one -- and "we knew and chose
            not to act" is a defensible position only while somebody can still
            see the choice. */}
        {dismissed.length > 0 ? (
          <section className="op-dismissed">
            <button
              type="button"
              className="op-dismissed-toggle"
              onClick={() => setShowDismissed((v) => !v)}
              aria-expanded={showDismissed}
            >
              {dismissed.length === 1
                ? "1 accepted finding"
                : `${dismissed.length} accepted findings`}
              <span aria-hidden="true">{showDismissed ? " ▾" : " ▸"}</span>
            </button>
            {showDismissed ? (
              <ul className="op-list op-list-quiet">
                {dismissed.map((finding) => (
                  <li className="op-item accepted" key={finding.id}>
                    <div className="op-main">
                      <p className="op-title">{finding.title}</p>
                      <p className="op-meta">
                        <span className="op-biz">{finding.businessName}</span>
                        <span>{finding.operator}</span>
                        <span>standing {since(finding.firstSeenAt)}</span>
                        {/* Who accepted it. A dismissal is an act by somebody
                            and is shown as one -- an anonymous one is an
                            invitation to accept things nobody will answer for. */}
                        {finding.dismissedBy ? (
                          <span className="op-by">accepted by {finding.dismissedBy}</span>
                        ) : null}
                      </p>
                    </div>
                    <div className="op-side">
                      <button
                        type="button"
                        className="op-accept"
                        onClick={() => void act(finding)}
                        disabled={busy.has(finding.id)}
                        title="Put this back on the list"
                      >
                        {busy.has(finding.id) ? "…" : "Restore"}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="op-note">
                Still true and still watched. They do not raise alerts and are not counted above,
                and any that goes away and comes back arrives un-accepted.
              </p>
            )}
          </section>
        ) : null}

        <p className={sweep.alerts ? "op-alerts" : "op-alerts off"}>
          {describeAlerts(sweep.alerts, sweep.alertsWarn)}
        </p>

        <section className="op-roster">
          <h2 className="act-sub-head">What is being watched</h2>
          <ul>
            {operators.map((operator) => (
              <li key={operator.slug}>
                <strong>{operator.title}</strong>
                <span>{operator.description}</span>
              </li>
            ))}
          </ul>
          <p className="op-note">
            This list comes from the code that runs, not from what has been found — so an operator
            that has never reported anything still appears. &ldquo;Found nothing&rdquo; and
            &ldquo;never ran&rdquo; would otherwise look identical, and they are opposite news.
          </p>
        </section>
      </div>
    </div>
  );
}

/** Rough age. Precision past "days" is not something anyone acts on differently. */
function since(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "an unknown time";
  const minutes = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
