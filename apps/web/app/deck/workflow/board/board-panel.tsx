"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { workflowFor, type Board, type BoardCard, type BusinessSlug, type WorkflowAudit } from "@nexus/shared";
import { getWorkflowBoard, moveBoardCard, readableError } from "@/lib/api";
import { updatedLabel } from "@/lib/workflow/pulse";
import { WorkflowBoardView, type AddRequest } from "./board-view";

/**
 * The workflow board's state (3 Nov 2026): it loads the board, keeps the cards
 * on screen while it asks again, and says in words what happened to a move.
 *
 * A move is the server's: the board redraws from what it saved. A refused move
 * leaves the card where it was and shows the rule's own words; a 409 means a
 * colleague moved the card first, so the board is fetched again; an answer
 * that arrives after a newer question is dropped.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §2, §9
 */
export function WorkflowBoardPanel({ slug, audit }: { slug: BusinessSlug; audit: WorkflowAudit | null }) {
  const workflow = workflowFor(slug);
  const [board, setBoard] = useState<Board | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [, setOpened] = useState<{ card: BoardCard; el: HTMLElement | null } | null>(null);
  const [, setAdding] = useState<AddRequest | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const asked = ++requestId.current;
    setLoading(true);
    setLoadError("");
    try {
      const data = await getWorkflowBoard(slug);
      if (asked !== requestId.current) return;
      setBoard(data);
      setFetchedAt(Date.now());
      setNow(Date.now());
    } catch (err) {
      if (asked !== requestId.current) return;
      setLoadError(readableError(err));
    } finally {
      if (asked === requestId.current) setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    void load();
  }, [load]);

  // Days in a step and "Updated … ago" move on by themselves.
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(tick);
  }, []);

  /** Thrown on failure, so the drag puts the card back and plays no chime. */
  const move = useCallback(
    async (cardId: string, from: string, to: string) => {
      const card = board ? [...board.units, ...board.deals].find((c) => c.id === cardId) : undefined;
      if (!card) return;
      setStatus("");
      try {
        await moveBoardCard(slug, card.kind === "unit" ? "units" : "deals", cardId, from, to);
        await load();
      } catch (err) {
        setStatus(readableError(err));
        // Someone moved it first: show where it really is.
        if (err instanceof Error && /^API 409 /.test(err.message)) void load();
        throw err;
      }
    },
    [board, slug, load]
  );

  if (!workflow) return null;

  return (
    <div className="wf-board-panel">
      <div className="wf-board-bar">
        <div className="wf-fresh">
          {board && fetchedAt !== null ? <span className="wf-updated">{updatedLabel(fetchedAt, now)}</span> : null}
          <button type="button" className="kit-pill quiet" disabled={loading} aria-busy={loading} onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>
      <p className="wf-board-status" role="status" aria-live="polite">
        {status}
      </p>

      {loadError ? (
        <div className="act-empty wf-error" role="alert">
          <strong>The board could not be loaded.</strong>
          <br />
          {loadError}
          {board ? (
            <>
              <br />
              The cards below are the last ones received.
            </>
          ) : null}
          <div className="wf-error-actions">
            <button type="button" className="btn" onClick={() => void load()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}

      {!board ? (
        loadError ? null : (
          <div className="wf-loading" aria-busy="true" aria-label="Loading the board">
            <div className="wf-skeleton wf-skeleton-bar" />
            <div className="wf-skeleton wf-skeleton-lanes" />
            <div className="wf-skeleton wf-skeleton-lanes" />
          </div>
        )
      ) : (
        <WorkflowBoardView
          workflow={workflow}
          board={board}
          audit={audit}
          now={now}
          onMove={move}
          onOpen={(card, el) => setOpened({ card, el })}
          onAdd={setAdding}
        />
      )}
    </div>
  );
}
