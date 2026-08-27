"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import {
  getFindings,
  getDismissalHorizons,
  getNotReported,
  type NotReportedConversation,
  dismissFinding,
  restoreFinding,
  type DismissalHorizonOption,
  type OperatorFinding,
  type OperatorInfo, readableError } from "@/lib/api";
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

/**
 * What the buttons say before the server has answered.
 *
 * Kept in step with DISMISSAL_HORIZONS by a test rather than by care -- the
 * server refuses a key it does not know, so a stale copy here would be an
 * Accept button that fails.
 */
const FALLBACK_HORIZONS: DismissalHorizonOption[] = [
  { key: "day", label: "for a day", hours: 24, describes: "It comes back tomorrow if it is still true." },
  { key: "week", label: "for a week", hours: 168, describes: "Long enough to get to it, short enough not to forget it." },
  { key: "month", label: "for a month", hours: 720, describes: "For something already decided. It is still reviewed, just not soon." },
];

const DEFAULT_HORIZON = "week";

export default function OperatorsPage() {
  const [findings, setFindings] = useState<OperatorFinding[]>([]);
  const [operators, setOperators] = useState<OperatorInfo[]>([]);
  const [counts, setCounts] = useState({ urgent: 0, warn: 0, info: 0, dismissed: 0 });
  /** Ids currently being accepted or restored, so a click cannot fire twice. */
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** Whether the accepted list is expanded. Collapsed by default, never hidden. */
  const [showDismissed, setShowDismissed] = useState(false);
  /** The finding whose "how long for" choice is open, if any. */
  const [choosing, setChoosing] = useState<string | null>(null);
  /**
   * Unanswered conversations the checks decided not to report.
   *
   * Kept apart from `findings` deliberately: these are NOT findings, and
   * folding them in would undo the suppression this screen is only trying to
   * make visible. The point is that somebody can audit the judgement, not
   * that the judgement is reversed.
   */
  const [notReported, setNotReported] = useState<NotReportedConversation[]>([]);
  const [showNotReported, setShowNotReported] = useState(false);
  /**
   * Whether the suppressed list could be READ, which is not whether it is empty.
   *
   * The register's recipe for this class, applied: when a fallback value would
   * be indistinguishable from a real answer, carry a second field saying which
   * it was and surface it where the reader is.
   *
   * Three states. `true` — asked and answered. `false` — asked and could not be
   * told, which must not render as "nothing was suppressed". `null` — never
   * asked, either because the load has not returned or because this is an
   * employee, for whom the whole section is correctly absent.
   */
  const [suppressionReadable, setSuppressionReadable] = useState<boolean | null>(null);
  /**
   * The lengths on offer, from the server.
   *
   * Seeded with the same three the server has so the button works on the first
   * paint and if the fetch fails -- an Accept button that does nothing because
   * a menu did not arrive is worse than one offering a length the server might
   * refuse, and it will not refuse these.
   */
  const [horizons, setHorizons] = useState<DismissalHorizonOption[]>(FALLBACK_HORIZONS);
  const [sweep, setSweep] = useState<{
    lastSweptAt: string | null;
    stalled: boolean;
    /**
     * THREE STATES, NOT TWO.
     *
     * `false` used to mean both "we asked, and nothing is configured" and "we
     * have not asked yet". The render could not tell them apart, so on a failed
     * load — and for the whole first paint — the page stated flatly that no
     * alert destination was set. It did not know that. It was printing its own
     * initial value as a finding.
     *
     * Which is the failure this page's own comment warns about two branches
     * further down: falling through to a confident empty state when the truth
     * is that nobody could ask. `null` is that truth, and it renders as
     * nothing.
     */
    alerts: boolean | null;
    alertsWarn: boolean;
  }>({
    lastSweptAt: null,
    stalled: false,
    alerts: null,
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
      setLoadError(readableError(err));
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
  useEffect(() => {
    // Operator-only on the server; an employee simply gets nothing, which is
    // the right shape here -- this list carries other firms' customers.
    getNotReported()
      .then((data) => {
        setNotReported(data.conversations);
        setSuppressionReadable(true);
      })
      .catch((err) => {
        // AN ERROR MUST NOT BECOME A VALUE THAT READS AS A FACT, and this
        // section is the one place on the deck where that would be sharpest: an
        // empty list here says "nothing was suppressed", which is the exact
        // sentence it exists to stop being said falsely.
        //
        // A 403 is not a failure. It is an employee being told this is not
        // theirs to read, and it should render as nothing at all rather than as
        // an alarm about a list they were never going to see.
        const forbidden = err instanceof Error && err.message.includes("403");
        setSuppressionReadable(forbidden ? null : false);
      });
  }, []);

  useEffect(() => {
    getDismissalHorizons()
      .then((data) => {
        if (data.horizons.length > 0) setHorizons(data.horizons);
      })
      .catch(() => undefined);
  }, []);

  const act = useCallback(
    async (finding: OperatorFinding, forHow = DEFAULT_HORIZON) => {
      const id = finding.id;
      if (busy.has(id)) return;
      setBusy((prev) => new Set(prev).add(id));
      setError("");
      try {
        if (finding.dismissedAt) await restoreFinding(id);
        else await dismissFinding(id, forHow);
        setChoosing(null);
        await load(business);
      } catch (err) {
        setError(readableError(err));
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
                  {/* ACCEPTING ASKS HOW LONG FOR, and the second click is
                      the feature rather than friction. Until 2026-08-25 this
                      was one button and the acceptance was forever: production
                      held an urgent finding accepted at 118 hours of a customer
                      waiting, which read 142 a day later and could never come
                      back, because the only thing that cleared an acceptance
                      was the finding resolving and it never did. */}
                  {choosing === finding.id ? (
                    <div className="op-forhow">
                      {horizons.map((h) => (
                        <button
                          key={h.key}
                          type="button"
                          className="op-forhow-opt"
                          onClick={() => void act(finding, h.key)}
                          disabled={busy.has(finding.id)}
                          title={h.describes}
                        >
                          {h.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="op-forhow-cancel"
                        onClick={() => setChoosing(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="op-accept"
                      onClick={() => setChoosing(finding.id)}
                      disabled={busy.has(finding.id)}
                      title="Still true, but you have seen it and it does not need action yet"
                    >
                      {busy.has(finding.id) ? "…" : "Accept"}
                    </button>
                  )}
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
                        {/* An acceptance with a visible end. Without this the
                            section says four things are accepted and gives no
                            way to tell which of them is about to return. */}
                        <span className="op-until">{comesBack(finding.dismissedUntil)}</span>
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

        {/* WHAT WAS DELIBERATELY NOT REPORTED.

            An empty findings list must not read as good news unless it IS
            good news, and until now "nobody is waiting" and "two people are
            waiting and we judged them salesmen" looked identical from here.

            The judgement is made by a rules scorer, on the last message the
            customer sent. It is usually right and it is not checked by
            anything at the moment it is made -- so the excerpt is shown, and
            it is the whole point of the row. */}
        {/* SAID BEFORE THE LIST, because its absence is the misleading state.
            Rendering nothing here would mean an unreachable endpoint and a
            genuinely quiet platform look identical — on the one section whose
            purpose is that they never should. */}
        {suppressionReadable === false ? (
          <p className="op-note op-unreadable">
            The suppressed conversations could not be read, so this is not a report that none
            were suppressed — it is no report at all.
          </p>
        ) : null}

        {notReported.length > 0 ? (
          <section className="op-dismissed op-quiet">
            <button
              type="button"
              className="op-dismissed-toggle"
              onClick={() => setShowNotReported((v) => !v)}
              aria-expanded={showNotReported}
            >
              {notReported.length === 1
                ? "1 unanswered conversation was not reported"
                : `${notReported.length} unanswered conversations were not reported`}
              <span aria-hidden="true">{showNotReported ? " ▾" : " ▸"}</span>
            </button>
            {showNotReported ? (
              <ul className="op-list op-list-quiet">
                {notReported.map((row) => (
                  <li className="op-item accepted" key={row.conversationId}>
                    <div className="op-main">
                      <p className="op-title">
                        {row.who} — waiting {Math.round(row.waitedHours)}h, read as a sales pitch
                      </p>
                      {/* THEIR OWN WORDS. Without this the row asserts a
                          judgement and gives nothing to check it against. */}
                      <p className="op-excerpt">“{row.excerpt}”</p>
                      <p className="op-meta">
                        <span className="op-biz">{row.businessSlug}</span>
                        <span>
                          {row.reason === "colleague"
                            ? "on our own rota — a colleague, not a customer"
                            : row.classified
                              ? "classified when it arrived"
                              : "re-read just now — never scored at the time"}
                        </span>
                      </p>
                    </div>
                    <div className="op-side">
                      <a className="op-accept" href="/inbox">
                        Open inbox
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="op-note">
                Somebody messaged, nothing went back, and the checks judged them to be selling
                rather than buying — so no alert was raised. Open the list to see what they
                actually said.
              </p>
            )}
          </section>
        ) : null}

        {/* Only once a load has actually answered. Before that this said "no
            alert destination is set" from its own initial value, on every first
            paint and on every failed load — a default wearing the shape of a
            fact, on the one screen whose entire premise is not doing that. */}
        {sweep.alerts === null ? null : (
          <p className={sweep.alerts ? "op-alerts" : "op-alerts off"}>
            {describeAlerts(sweep.alerts, sweep.alertsWarn)}
          </p>
        )}

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
/**
 * When an acceptance runs out, said forwards.
 *
 * "comes back in 6d" rather than a date, matching `since` above: the reader is
 * deciding whether to act now, and a date makes them do the arithmetic. Null is
 * a row from before horizons existed that migration 065 has not reached; it says
 * so rather than implying an end it cannot name.
 */
function comesBack(iso: string | null): string {
  if (!iso) return "no end recorded";
  const until = new Date(iso).getTime();
  if (Number.isNaN(until)) return "no end recorded";
  const minutes = Math.round((until - Date.now()) / 60000);
  if (minutes <= 0) return "comes back on the next check";
  if (minutes < 60) return `comes back in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `comes back in ${hours}h`;
  return `comes back in ${Math.round(hours / 24)}d`;
}

function since(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "an unknown time";
  const minutes = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
