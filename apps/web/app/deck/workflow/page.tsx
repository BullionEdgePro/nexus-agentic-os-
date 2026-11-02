"use client";

import { useEffect, useRef, useState } from "react";
import {
  BUSINESSES_WITH_WORKFLOW,
  verdict,
  workflowFor,
  type AuditDays,
  type BusinessSlug,
  type WorkflowAudit,
} from "@nexus/shared";
import { getWorkflowAudit, readableError } from "@/lib/api";
import { useVisibleBusinesses } from "@/lib/business-tabs";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import { openFromCard } from "../../kit/card-window";
import { WorkflowLanes } from "./lanes";
import { StepWindow } from "./step-window";
import { AuditTiles, AuditCharts } from "./audit-charts";
import { ComplianceTable } from "./compliance";
import { NoWorkflow } from "./empty";
import "../deck.css";
import "../activity/activity.css";
import "../../kit/kit.css";
import "./workflow.css";

/**
 * The workflow audit (2 Nov 2026): a business's own drawn workflow — for SFS
 * International, the boss's 20-step "AI agent workflow" — checked step by step
 * against what Nexus actually recorded, then the period's figures and charts.
 *
 * WHO SEES WHAT. Admins pick any business with a workflow (`?business=` from
 * Business HQ); staff always see their own business, and every SFS staff
 * member sees the whole team's figures — no colleague's numbers by name. The
 * server enforces the same through requireTenantScope.
 *
 * EVERY FIGURE IS THE AUDIT'S. Nothing on this page is typed in: a step Nexus
 * does not track says so, a day with no reply is an empty slot, and a period
 * switch replaces the whole page — an answer that arrives after a newer
 * question is dropped, so 7 days' figures never sit under the 30-day pill.
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md
 */

const PERIODS: AuditDays[] = [7, 30, 90];

const nameOf = (slug: string) => TENANTS.find((t) => t.slug === slug)?.name ?? slug;

export default function WorkflowAuditPage() {
  const { isOperator, known, mySlug } = useVisibleBusinesses();
  // The admin's ?business=, read once in the browser; undefined until read.
  const [requested, setRequested] = useState<string | null | undefined>(undefined);
  const [days, setDays] = useState<AuditDays>(30);
  const [audit, setAudit] = useState<WorkflowAudit | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [opened, setOpened] = useState<{ id: string; card: HTMLElement } | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    setRequested(new URLSearchParams(window.location.search).get("business"));
  }, []);

  // Whose audit: an admin's choice (else the first business with a workflow),
  // staff their own. Undefined while who is asking is still being read.
  const slug: string | null | undefined =
    !known || requested === undefined ? undefined : isOperator ? (requested ?? BUSINESSES_WITH_WORKFLOW[0] ?? null) : mySlug;
  const workflow = slug ? workflowFor(slug) : null;

  useEffect(() => {
    if (!slug || !workflow) return;
    void (async () => {
      const asked = ++requestId.current;
      setLoading(true);
      setLoadError("");
      setOpened(null);
      try {
        const data = await getWorkflowAudit(slug as BusinessSlug, days);
        if (asked !== requestId.current) return;
        setAudit(data);
      } catch (err) {
        if (asked !== requestId.current) return;
        setAudit(null);
        setLoadError(readableError(err));
      } finally {
        if (asked === requestId.current) setLoading(false);
      }
    })();
  }, [slug, workflow, days]);

  function chooseBusiness(next: string) {
    setRequested(next);
    window.history.replaceState(null, "", `/deck/workflow?business=${encodeURIComponent(next)}`);
  }

  const counts = audit && workflow ? verdict(workflow, audit.evidence) : null;
  const step = opened && workflow ? workflow.steps.find((s) => s.id === opened.id) ?? null : null;

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root wf-page">
        <header className="act-head">
          <h1>Workflow audit{slug ? ` · ${nameOf(slug)}` : ""}</h1>
        </header>
        <p className="act-lede">
          The workflow drawn for this business, step by step, against what Nexus actually recorded — then
          the period&rsquo;s own figures. Nothing here is typed in: a step Nexus does not track yet says so,
          with what tracking it would need.
        </p>

        {isOperator && BUSINESSES_WITH_WORKFLOW.length > 0 ? (
          <div className="kit-pills wf-pills" role="group" aria-label="Business">
            {BUSINESSES_WITH_WORKFLOW.map((b) => (
              <button key={b} type="button" className="kit-pill quiet" aria-pressed={b === slug} onClick={() => chooseBusiness(b)}>
                {nameOf(b)}
              </button>
            ))}
          </div>
        ) : null}

        {slug === undefined ? (
          <div className="act-empty">Loading…</div>
        ) : !workflow ? (
          <NoWorkflow />
        ) : (
          <>
            <div className="kit-pills wf-pills" role="group" aria-label="Period">
              {PERIODS.map((d) => (
                <button key={d} type="button" className="kit-pill quiet" aria-pressed={d === days} onClick={() => setDays(d)}>
                  {d} days
                </button>
              ))}
            </div>

            {loading ? (
              <div className="act-empty">Loading…</div>
            ) : loadError || !audit ? (
              <div className="act-empty" role="alert">
                <strong>The audit could not be loaded.</strong>
                {loadError ? (
                  <>
                    <br />
                    {loadError}
                  </>
                ) : null}
              </div>
            ) : (
              <>
                {counts ? (
                  <p className="wf-verdict">
                    {counts.working} working · {counts.idle} idle · {counts.partly} partly · {counts.not_tracked} not tracked in
                    Nexus yet <span className="wf-verdict-days">· the last {audit.period.days} days</span>
                  </p>
                ) : null}

                <section className="wf-section" aria-labelledby="wf-h-flow">
                  <h2 id="wf-h-flow" className="wf-h2">
                    {workflow.title}
                  </h2>
                  <WorkflowLanes
                    workflow={workflow}
                    evidence={audit.evidence}
                    onOpen={(id, card) => openFromCard(card, () => setOpened({ id, card }))}
                  />
                </section>

                <section className="wf-section" aria-labelledby="wf-h-figures">
                  <h2 id="wf-h-figures" className="wf-h2">
                    How it went
                  </h2>
                  <AuditTiles audit={audit} />
                  <AuditCharts audit={audit} />
                </section>

                <section className="wf-section" aria-labelledby="wf-h-compliance">
                  <h2 id="wf-h-compliance" className="wf-h2">
                    Dubai compliance
                  </h2>
                  <ComplianceTable evidence={audit.evidence} />
                </section>

                {step ? <StepWindow step={step} evidence={audit.evidence} origin={opened?.card ?? null} onClose={() => setOpened(null)} /> : null}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
