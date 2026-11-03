"use client";

import { useEffect, useState } from "react";
import { BUSINESSES_WITH_WORKFLOW, workflowFor, type BusinessSlug } from "@nexus/shared";
import { useVisibleBusinesses } from "@/lib/business-tabs";
import { fontVariables } from "@/lib/fonts";
import { TENANTS } from "@/lib/tenants";
import { WorkflowPanel } from "./panel";
import { NoWorkflow } from "./empty";
import "../deck.css";
import "../activity/activity.css";
import "../../kit/kit.css";
import "./workflow.css";

/**
 * The workflow (2 Nov 2026; one panel with Business HQ's Workflow tab since
 * 3 Nov): a business's own drawn workflow — for SFS International, the boss's
 * 20-step "AI agent workflow" — checked step by step against what Nexus
 * actually recorded, then the period's figures and charts.
 *
 * WHO SEES WHAT. Admins pick any business with a workflow (`?business=` from
 * Business HQ); staff always see their own business, and every SFS staff
 * member sees the whole team's figures — no colleague's numbers by name. The
 * server enforces the same through requireTenantScope. Everything below the
 * header is the panel (panel.tsx), shared with Business HQ.
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md,
 * docs/superpowers/specs/2026-11-03-sfs-workflow-tab-design.md
 */

const nameOf = (slug: string) => TENANTS.find((t) => t.slug === slug)?.name ?? slug;

export default function WorkflowPage() {
  const { isOperator, known, mySlug } = useVisibleBusinesses();
  // The admin's ?business=, read once in the browser; undefined until read.
  const [requested, setRequested] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    setRequested(new URLSearchParams(window.location.search).get("business"));
  }, []);

  // Whose workflow: an admin's choice (else the first business with one),
  // staff their own. Undefined while who is asking is still being read.
  const slug = (!known || requested === undefined
    ? undefined
    : isOperator
      ? (requested ?? BUSINESSES_WITH_WORKFLOW[0] ?? null)
      : mySlug) as BusinessSlug | null | undefined;

  function chooseBusiness(next: string) {
    setRequested(next);
    window.history.replaceState(null, "", `/deck/workflow?business=${encodeURIComponent(next)}`);
  }

  return (
    <div className={`deck-root ${fontVariables}`}>
      <div className="act-root wf-page">
        <header className="act-head">
          <h1>Workflow{slug ? ` · ${nameOf(slug)}` : ""}</h1>
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
        ) : !slug || !workflowFor(slug) ? (
          <NoWorkflow />
        ) : (
          <WorkflowPanel key={slug} slug={slug} />
        )}
      </div>
    </div>
  );
}
