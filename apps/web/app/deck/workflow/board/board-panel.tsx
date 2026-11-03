"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { workflowFor, type Board, type BoardCard, type BusinessSlug, type CardMove, type WorkflowAudit } from "@nexus/shared";
import {
  closeBoardCard,
  createBoardDeal,
  createBoardUnit,
  getCardHistory,
  getContacts,
  getWorkflowBoard,
  linkBoardUnit,
  moveBoardCard,
  readableError,
  unlinkBoardUnit,
  updateBoardDeal,
  updateBoardUnit,
  type ContactSummary,
  type DealInput,
  type UnitInput,
} from "@/lib/api";
import { updatedLabel } from "@/lib/workflow/pulse";
import { CardWindow } from "../../../kit/card-window";
import { WorkflowBoardView, type AddRequest } from "./board-view";
import { CardDetail } from "./card-detail";
import { AddCard, type NewCard } from "./add-card";

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

const kindOf = (card: BoardCard) => (card.kind === "unit" ? "units" : "deals");
const raced = (err: unknown) => err instanceof Error && /^API 409 /.test(err.message);

export function WorkflowBoardPanel({ slug, audit }: { slug: BusinessSlug; audit: WorkflowAudit | null }) {
  const workflow = workflowFor(slug);
  const [board, setBoard] = useState<Board | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [status, setStatus] = useState("");
  const [opened, setOpened] = useState<{ id: string; el: HTMLElement | null } | null>(null);
  const [history, setHistory] = useState<CardMove[] | null>(null);
  const [detailMessage, setDetailMessage] = useState("");
  const [adding, setAdding] = useState<AddRequest | null>(null);
  const [addMessage, setAddMessage] = useState("");
  const [contacts, setContacts] = useState<ContactSummary[]>([]);
  const requestId = useRef(0);
  const historyFor = useRef<string | null>(null);
  const searchId = useRef(0);

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

  const loadHistory = useCallback(
    async (card: BoardCard) => {
      historyFor.current = card.id;
      setHistory(null);
      try {
        const { moves } = await getCardHistory(slug, kindOf(card), card.id);
        if (historyFor.current === card.id) setHistory(moves);
      } catch {
        if (historyFor.current === card.id) setHistory([]);
      }
    },
    [slug]
  );

  /** Thrown on failure, so the drag puts the card back and plays no chime. */
  const move = useCallback(
    async (cardId: string, from: string, to: string) => {
      const card = board ? [...board.units, ...board.deals].find((c) => c.id === cardId) : undefined;
      if (!card) return;
      setStatus("");
      try {
        await moveBoardCard(slug, kindOf(card), cardId, from, to);
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

  const cards: BoardCard[] = board ? [...board.units, ...board.deals] : [];
  const current = opened ? cards.find((c) => c.id === opened.id) ?? null : null;
  const stepName = (id: string) => workflow.steps.find((s) => s.id === id)?.name ?? id;

  /** Runs a change from the card window, then shows the board as saved. */
  async function fromWindow(card: BoardCard, change: () => Promise<unknown>, done: string) {
    setDetailMessage("");
    try {
      await change();
      setDetailMessage(done);
      await load();
      void loadHistory(card);
    } catch (err) {
      setDetailMessage(readableError(err));
      if (raced(err)) void load();
    }
  }

  async function create(card: NewCard) {
    setAddMessage("");
    try {
      if (card.kind === "unit") {
        const { kind: _kind, ...input } = card;
        await createBoardUnit(slug, input);
        setStatus("Unit added on Classify unit.");
      } else {
        const { kind: _kind, ...input } = card;
        await createBoardDeal(slug, input);
        setStatus(`Lead put on ${stepName(input.step)}.`);
      }
      setAdding(null);
      await load();
    } catch (err) {
      setAddMessage(readableError(err));
    }
  }

  function search(query: string) {
    const asked = ++searchId.current;
    getContacts(slug, query)
      .then((r) => {
        if (asked === searchId.current) setContacts(r.contacts.slice(0, 8));
      })
      .catch(() => {
        if (asked === searchId.current) setContacts([]);
      });
  }

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
          onOpen={(card, el) => {
            setOpened({ id: card.id, el });
            setDetailMessage("");
            void loadHistory(card);
          }}
          onAdd={(request) => {
            setAdding(request);
            setAddMessage("");
            setContacts([]);
          }}
        />
      )}

      {board && current ? (
        <CardDetail
          key={current.id}
          workflow={workflow}
          card={current}
          board={board}
          history={history}
          now={now}
          timezone={audit?.business.timezone ?? "Asia/Dubai"}
          origin={opened?.el ?? null}
          message={detailMessage}
          onDismiss={() => setOpened(null)}
          onSave={(changes) =>
            fromWindow(
              current,
              () =>
                current.kind === "unit"
                  ? updateBoardUnit(slug, current.id, changes as UnitInput)
                  : updateBoardDeal(slug, current.id, changes as DealInput),
              "Saved."
            )
          }
          onMove={(to) =>
            void move(current.id, current.step, to)
              .then(() => {
                setDetailMessage(`Moved to ${stepName(to)}.`);
                void loadHistory(current);
              })
              .catch((err) => setDetailMessage(readableError(err)))
          }
          onCloseCard={(reason, note) => {
            setDetailMessage("");
            closeBoardCard(slug, kindOf(current), current.id, reason, note)
              .then(async () => {
                setOpened(null);
                setStatus(`${current.kind === "unit" ? "Unit" : "Deal"} closed.`);
                await load();
              })
              .catch((err) => {
                setDetailMessage(readableError(err));
                if (raced(err)) void load();
              });
          }}
          onLink={(unitId) => void fromWindow(current, () => linkBoardUnit(slug, current.id, unitId), "Unit offered.")}
          onUnlink={(unitId) => void fromWindow(current, () => unlinkBoardUnit(slug, current.id, unitId), "Unit removed.")}
        />
      ) : null}

      {adding ? (
        <CardWindow open title={adding.kind === "unit" ? "Add a unit" : "Put a lead on the board"} onClose={() => setAdding(null)} origin={null}>
          <AddCard
            kind={adding.kind}
            preset={adding.kind === "deal" && adding.contactId ? { contactId: adding.contactId, name: adding.name ?? null } : null}
            contacts={contacts}
            message={addMessage}
            onSearch={search}
            onCreate={create}
            onDismiss={() => setAdding(null)}
          />
        </CardWindow>
      ) : null}
    </div>
  );
}
