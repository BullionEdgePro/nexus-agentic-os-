"use client";

import { useEffect, useState } from "react";
import { workflowFor, type BusinessSlug } from "@nexus/shared";
import { getWorkflowBoard, readableError } from "@/lib/api";
import { useVisibleBusinesses } from "@/lib/business-tabs";
import { myBoardSummary, type MyBoardSummary } from "@/lib/workflow/my-board";

/**
 * "My board" on My Day (25 Nov 2026): a staff member's own units and deals on
 * the Workflow Board by step, and what of theirs needs them — each line opens
 * that card on the board. Staff only, and only when their business has a
 * board; an admin, or a business without one, sees nothing here.
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §4
 */
export function MyBoard() {
  const { isOperator, known, mySlug } = useVisibleBusinesses();
  const [summary, setSummary] = useState<MyBoardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slug = known && !isOperator && mySlug ? (mySlug as BusinessSlug) : null;
  const workflow = slug ? workflowFor(slug) : null;

  useEffect(() => {
    if (!slug || !workflow) return;
    let cancelled = false;
    getWorkflowBoard(slug)
      .then((board) => {
        if (cancelled || board.viewer.seesAll) return;
        setSummary(myBoardSummary(workflow, board, Date.now(), "Asia/Dubai"));
      })
      .catch((err) => {
        if (!cancelled) setError(readableError(err, "Could not load your board."));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, workflow]);

  if (!slug || !workflow || (!summary && !error)) return null;
  return <MyBoardView summary={summary} error={error} />;
}

const line = (rows: { name: string; n: number }[]) => rows.map((r) => `${r.name} ${r.n}`).join(" · ");

export function MyBoardView({ summary, error }: { summary: MyBoardSummary | null; error: string | null }) {
  const units = summary ? [line(summary.units), summary.liveOnBayut > 0 ? `Live on Bayut ${summary.liveOnBayut}` : ""].filter(Boolean).join(" · ") : "";
  const deals = summary ? line(summary.deals) : "";
  const nothing = !!summary && !units && !deals;
  return (
    <section className="day-card day-board" id="day-board" aria-labelledby="day-board-title">
      <header className="day-board-head">
        <h2 id="day-board-title">My board</h2>
        <a className="day-board-open" href="/deck/workflow">
          Open board →
        </a>
      </header>
      {error || !summary ? (
        <p className="day-board-note">Could not load your board.</p>
      ) : nothing ? (
        <p className="day-board-note">Nothing of yours on the board</p>
      ) : (
        <dl className="day-board-lines">
          {units ? (
            <>
              <dt>Units</dt>
              <dd>{units}</dd>
            </>
          ) : null}
          {deals ? (
            <>
              <dt>Deals</dt>
              <dd>{deals}</dd>
            </>
          ) : null}
        </dl>
      )}
      {summary && summary.needsMe.length > 0 ? (
        <>
          <h3 className="day-board-needs-title">Needs me</h3>
          <ul className="day-board-needs">
            {summary.needsMe.map((n) => (
              <li key={n.cardId}>
                <a href={`/deck/workflow?card=${encodeURIComponent(n.cardId)}`}>{n.text}</a>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
