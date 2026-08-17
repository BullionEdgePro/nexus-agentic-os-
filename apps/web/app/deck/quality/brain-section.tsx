"use client";

import { useEffect, useState } from "react";
import { getSharedBrain, readableError, type BrainStatus, type SharedPattern } from "@/lib/api";

/**
 * The shared brain (F5), made visible for the first time.
 *
 * `rollUpSharedPatterns` has been running on the hourly quality rollup for
 * weeks, `/api/quality/shared` has been serving the result, and nothing in the
 * product has ever shown it. A pooled store nobody can look at cannot be told
 * apart from one that is broken — which is the exact confusion this feature has
 * already lost time to once, when intent came from tool calls alone, 83% of
 * traffic fired no tool, and the store spent months reading a sixth of the
 * platform while reporting an emptiness that looked like youth.
 *
 * SO THE COVERAGE NUMBERS COME FIRST, ABOVE THE PATTERNS. The patterns are what
 * F5 is for; the coverage is whether F5 can see anything at all, and only one of
 * those two is fixable by waiting. Putting the pool first would repeat the
 * original mistake in a nicer font.
 *
 * Sits on Agent quality rather than in its own tab: this is the platform-wide
 * version of the per-business numbers above it, drawn from the same
 * `conversation_metrics` rows by the same hourly job, and the honest thing is to
 * let somebody read one against the other.
 */
export function BrainSection() {
  const [patterns, setPatterns] = useState<SharedPattern[]>([]);
  const [status, setStatus] = useState<BrainStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    getSharedBrain()
      .then((data) => {
        if (cancelled) return;
        setPatterns(data.patterns);
        setStatus(data.status);
      })
      .catch((err) => {
        if (!cancelled) setError(readableError(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // A defect, not a quiet week — the distinction the whole section exists for.
  const classifierStopped = (status?.coverage.neverClassified ?? 0) > 0;

  return (
    <section className="br-root">
      <h2 className="act-sub-head">Pooled across every business</h2>
      <p className="act-lede">
        What the platform has learned from all five businesses at once, so a business with no
        history of its own can still be told that a kind of enquiry usually needs a person. Nothing
        anybody wrote is in here — only counts, rates and intent labels cross a tenant boundary,
        and the redaction gate fails closed.
      </p>

      {/* A FAILED READ MUST NOT RENDER AS MEASURED ZEROS.
          The first version of this fell back to `?? 0` throughout, so an
          unreachable API produced "0 conversations measured, 0 patterns stored"
          — a screen that says the platform has learned nothing, when what
          happened is that nobody asked it. That is the exact failure this whole
          section exists to expose in F5, reproduced by the section itself, and
          it was only visible by looking at the rendered page. */}
      {error ? (
        <div className="br-blocked">
          <strong>Could not read the pooled numbers.</strong>
          <p>
            {error} Nothing below is being shown, because an empty pool and an unanswered request
            look identical once they are drawn as zeros.
          </p>
        </div>
      ) : loading ? (
        <div className="act-empty">Loading…</div>
      ) : !status ? null : (
        <>
          {/* Can it see anything? Before: does it know anything? */}
          <div className="br-counts">
            <div className="br-count">
              <strong>{status.coverage.conversations}</strong>
              <span>conversations measured</span>
            </div>
            <div className="br-count">
              <strong>{Math.round(status.coverage.rate * 100)}%</strong>
              <span>carried a poolable intent</span>
            </div>
            <div className="br-count">
              <strong>{status.coverage.nonPatternOnly}</strong>
              <span>unknown or a sales pitch — correctly not pooled</span>
            </div>
            <div className={`br-count${classifierStopped ? " bad" : ""}`}>
              <strong>{status.coverage.neverClassified}</strong>
              <span>never classified</span>
            </div>
          </div>

          {classifierStopped ? (
            <p className="br-defect">
              <strong>That last number should be zero.</strong> Nothing in the reply path writes a
              conversation without an intent any more, so anything above zero is either a
              historical row or the classifier having stopped — and while it is stopped, everything
              keyed on intent looks merely quiet. The <em>intent-unclassified</em> operator raises
              this on Needs attention.
            </p>
          ) : null}

          <div className="br-counts">
            <div className="br-count">
              <strong>{status.patternsStored}</strong>
              <span>patterns stored</span>
            </div>
            <div className={`br-count${status.patternsShareable > 0 ? " live" : ""}`}>
              <strong>{status.patternsShareable}</strong>
              <span>strong enough to act on</span>
            </div>
            <div className="br-count">
              <strong>{status.contributingTenants}</strong>
              <span>businesses contributing to the biggest</span>
            </div>
          </div>

          {/* An explained absence, given the same weight as a result — the same
              call the procedures screen makes, for the same reason. */}
          {status.blockedBecause ? (
            <div className="br-blocked">
              <strong>Nothing to offer yet.</strong>
              <p>{status.blockedBecause}</p>
            </div>
          ) : null}

          {patterns.length > 0 ? (
            <table className="br-table">
              <thead>
                <tr>
                  <th>Kind of enquiry</th>
                  <th>Language</th>
                  <th>Conversations</th>
                  <th>Businesses</th>
                  <th>Ends with a person</th>
                </tr>
              </thead>
              <tbody>
                {patterns.map((pattern) => (
                  <tr key={`${pattern.intentCategory}-${pattern.language}`}>
                    <td>{humanise(pattern.intentCategory)}</td>
                    <td>{pattern.language}</td>
                    <td>{pattern.sampleCount}</td>
                    <td>{pattern.contributingTenants}</td>
                    <td>{Math.round(pattern.escalationRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}

          {/* Said plainly, because a screen showing a pool nobody consumes would
              otherwise imply the agent is already using it. */}
          <p className="act-caveat">
            These numbers are not yet reaching any reply. `getSharedGuidance` is served by this
            endpoint and read by nothing on the customer path, so the brain currently informs a
            person rather than an agent. Wiring it into the reply is a decision about one
            business&apos;s answers being shaped by other businesses&apos; outcomes, and it wants
            its own argument rather than arriving as a side effect of a screen.
          </p>
        </>
      )}
    </section>
  );
}

/** `appointment_booking` is a database value; "Appointment booking" is English. */
function humanise(intent: string): string {
  const words = intent.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
