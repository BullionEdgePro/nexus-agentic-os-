"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { getFindings, type OperatorFinding, type OperatorInfo } from "@/lib/api";
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
  const [counts, setCounts] = useState({ urgent: 0, warn: 0, info: 0 });
  const [sweep, setSweep] = useState<{ lastSweptAt: string | null; stalled: boolean }>({
    lastSweptAt: null,
    stalled: false,
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
      setSweep({ lastSweptAt: data.lastSweptAt, stalled: data.sweepStalled });
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load findings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(business);
  }, [business, load]);

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
            </div>
          )
        ) : (
          <>
          {/* The list is capped server-side; the counts are not. At 250 open
              findings the page would show 200 and say nothing — a truncation
              that reads as "this is everything". Named rather than hidden,
              because a silent cap on a page whose whole job is "what needs
              attention" is the same failure the page exists to prevent. */}
          {total > findings.length ? (
            <p className="op-truncated">
              Showing the {findings.length} most serious of {total}. The rest are the same
              kinds of thing — clear these and the next ones appear.
            </p>
          ) : null}
          <ul className="op-list">
            {findings.map((finding) => (
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
                <span className={`op-sev ${finding.severity}`}>{finding.severity}</span>
              </li>
            ))}
          </ul>
          </>
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
function since(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "an unknown time";
  const minutes = Math.max(1, Math.round((Date.now() - then) / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
