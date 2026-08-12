"use client";

import { useCallback, useEffect, useState } from "react";
import type { BusinessSlug } from "@nexus/shared";
import { getFindings, type OperatorFinding, type OperatorInfo } from "@/lib/api";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import "../deck.css";
import "../activity/activity.css";
import "./operators.css";

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
export default function OperatorsPage() {
  const [findings, setFindings] = useState<OperatorFinding[]>([]);
  const [operators, setOperators] = useState<OperatorInfo[]>([]);
  const [counts, setCounts] = useState({ urgent: 0, warn: 0, info: 0 });
  const [business, setBusiness] = useState<BusinessSlug | "">("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (slug: BusinessSlug | "") => {
    setLoading(true);
    setError("");
    try {
      const data = await getFindings(slug);
      setFindings(data.findings);
      setCounts(data.counts);
      setOperators(data.operators);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load findings.");
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
        <a className="act-back" href="/">
          ← Command deck
        </a>

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

        {error ? <p className="act-msg">{error}</p> : null}

        {loading ? (
          <div className="act-empty">Loading…</div>
        ) : total === 0 ? (
          <div className="op-clear">
            <strong>Nothing needs attention.</strong>
            <p>
              No customer is waiting, nothing promised is overdue, and every knowledge source is
              indexing. Checked within the last ten minutes.
            </p>
          </div>
        ) : (
          <ul className="op-list">
            {findings.map((finding) => (
              <li className={`op-item ${finding.severity}`} key={finding.id}>
                <div className="op-main">
                  <p className="op-title">{finding.title}</p>
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
