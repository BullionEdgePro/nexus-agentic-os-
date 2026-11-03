"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { verdict, workflowFor, type AuditDays, type BusinessSlug, type WorkflowAudit } from "@nexus/shared";
import { getWorkflowAudit, readableError } from "@/lib/api";
import { isQuiet, updatedLabel } from "@/lib/workflow/pulse";
import { openFromCard } from "../../kit/card-window";
import { WorkflowLanes } from "./lanes";
import { StepWindow } from "./step-window";
import { AuditTiles, AuditCharts } from "./audit-charts";
import { ComplianceTable } from "./compliance";
import { WorkflowPulse } from "./pulse";
import { NoWorkflow } from "./empty";
import { WorkflowBoardPanel } from "./board/board-panel";

/**
 * One business's live workflow (3 Nov 2026, the SFS workflow tab): the panel the
 * Workflow page and the Workflow tab of Business HQ both draw, so the two can
 * never disagree.
 *
 * RELIABLE. While it loads, an outline of the page (busy, not a blank); when it
 * fails, the reason and Try again; Refresh asks again and keeps the figures on
 * screen until new ones land, and a failed refresh leaves them there with the
 * error above; "Updated" counts from when this browser received them. An answer
 * that arrives after a newer question is still dropped, and figures for another
 * period or business never sit under this one's pills.
 *
 * Its styles come from the page that draws it (activity.css, kit.css,
 * workflow.css), as for every component here, so it renders in the tests.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-tab-design.md §2
 */

const PERIODS: AuditDays[] = [7, 30, 90];

/** The live picture, or the board staff work on (3 Nov 2026); remembered per browser. */
type View = "picture" | "board";
const VIEWS: { id: View; label: string }[] = [
  { id: "picture", label: "Live picture" },
  { id: "board", label: "Board" },
];

export function WorkflowPanel({ slug, initialView = "picture" }: { slug: BusinessSlug; initialView?: View }) {
  const workflow = workflowFor(slug);
  const [view, setView] = useState<View>(initialView);
  const [days, setDays] = useState<AuditDays>(30);
  const [audit, setAudit] = useState<WorkflowAudit | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [opened, setOpened] = useState<{ id: string; card: HTMLElement } | null>(null);
  const requestId = useRef(0);

  const load = useCallback(
    async (period: AuditDays) => {
      const asked = ++requestId.current;
      setLoading(true);
      setLoadError("");
      try {
        const data = await getWorkflowAudit(slug, period);
        if (asked !== requestId.current) return;
        setAudit(data);
        setFetchedAt(Date.now());
        setNow(Date.now());
      } catch (err) {
        if (asked !== requestId.current) return;
        setLoadError(readableError(err));
      } finally {
        if (asked === requestId.current) setLoading(false);
      }
    },
    [slug]
  );

  useEffect(() => {
    if (!workflow) return;
    setOpened(null);
    void load(days);
  }, [workflow, days, load]);

  // "Updated … ago" moves on by itself.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  // This browser's last view. Storage can be missing or refuse (a private
  // window); the panel then simply opens on the live picture.
  useEffect(() => {
    try {
      const saved = localStorage.getItem("nexus.workflow.view");
      if (saved === "picture" || saved === "board") setView(saved);
    } catch {
      /* no storage: keep the default */
    }
  }, []);

  function choose(next: View) {
    setView(next);
    try {
      localStorage.setItem("nexus.workflow.view", next);
    } catch {
      /* not remembered, still shown */
    }
  }

  if (!workflow) return <NoWorkflow />;

  const shown = audit && audit.period.days === days && audit.business.slug === slug ? audit : null;
  const counts = shown ? verdict(workflow, shown.evidence) : null;
  const step = opened && shown ? workflow.steps.find((s) => s.id === opened.id) ?? null : null;

  return (
    <div className="wf-panel">
      <div className="wf-bar">
        <div className="kit-pills wf-pills" role="group" aria-label="View">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" className="kit-pill quiet" aria-pressed={v.id === view} onClick={() => choose(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
        {/* The board is always the open cards and the last 30 days: no period to pick. */}
        {view === "picture" ? (
          <>
            <div className="kit-pills wf-pills" role="group" aria-label="Period">
              {PERIODS.map((d) => (
                <button key={d} type="button" className="kit-pill quiet" aria-pressed={d === days} onClick={() => setDays(d)}>
                  {d} days
                </button>
              ))}
            </div>
            <div className="wf-fresh">
              {shown && fetchedAt !== null ? <span className="wf-updated">{updatedLabel(fetchedAt, now)}</span> : null}
              <button type="button" className="kit-pill quiet" disabled={loading} aria-busy={loading} onClick={() => void load(days)}>
                Refresh
              </button>
            </div>
          </>
        ) : null}
      </div>

      {view === "board" ? <WorkflowBoardPanel slug={slug} audit={shown} /> : null}

      {view === "board" ? null : loadError ? (
        <div className="act-empty wf-error" role="alert">
          <strong>The workflow could not be loaded.</strong>
          <br />
          {loadError}
          {shown ? (
            <>
              <br />
              The figures below are the last ones received.
            </>
          ) : null}
          <div className="wf-error-actions">
            <button type="button" className="btn" onClick={() => void load(days)}>
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {view === "board" ? null : !shown ? (
        loadError ? null : (
          <div className="wf-loading" aria-busy="true" aria-label="Loading the workflow">
            <div className="wf-skeleton wf-skeleton-bar" />
            <div className="wf-skeleton wf-skeleton-cards" />
            <div className="wf-skeleton wf-skeleton-lanes" />
          </div>
        )
      ) : (
        <>
          {counts ? (
            <p className="wf-verdict">
              {counts.working} working · {counts.idle} idle · {counts.partly} partly · {counts.not_tracked} not tracked in Nexus
              yet <span className="wf-verdict-days">· the last {shown.period.days} days</span>
            </p>
          ) : null}
          {isQuiet(shown) ? <p className="wf-quiet-period">Nothing was recorded in the last {shown.period.days} days.</p> : null}

          <WorkflowPulse workflow={workflow} audit={shown} />

          <section className="wf-section" aria-labelledby="wf-h-flow">
            <h2 id="wf-h-flow" className="wf-h2">
              {workflow.title}
            </h2>
            <WorkflowLanes
              workflow={workflow}
              evidence={shown.evidence}
              onOpen={(id, card) => openFromCard(card, () => setOpened({ id, card }))}
            />
          </section>

          <section className="wf-section" aria-labelledby="wf-h-figures">
            <h2 id="wf-h-figures" className="wf-h2">
              How it went
            </h2>
            <AuditTiles audit={shown} />
            <AuditCharts audit={shown} />
          </section>

          <section className="wf-section" aria-labelledby="wf-h-compliance">
            <h2 id="wf-h-compliance" className="wf-h2">
              Dubai compliance
            </h2>
            <ComplianceTable evidence={shown.evidence} />
          </section>

          {step ? <StepWindow step={step} evidence={shown.evidence} origin={opened?.card ?? null} onClose={() => setOpened(null)} /> : null}
        </>
      )}
    </div>
  );
}
