"use client";

import { Fragment, useId, useState } from "react";
import {
  automaticSteps,
  boardColumns,
  daysInStepLabel,
  moveProblem,
  type Board,
  type BoardCard,
  type Lane,
  type Workflow,
  type WorkflowAudit,
} from "@nexus/shared";
import { stepFigures } from "@/lib/workflow/step-figures";
import { HOT_SHOWN, isMine, splitColumns } from "@/lib/workflow/board-layout";
import { BoardColumn, useBoardDrag } from "../../../kit/board";
import { aed, cardTitle, WorkflowCard } from "./board-card";
import { isPublished } from "./portals-section";

/**
 * The workflow board (3 Nov 2026): the boss's two lanes as rows of columns,
 * one per step that takes cards. The steps Nexus runs by itself sit in a strip
 * of live counts in front of each lane — never a place to drop — and the
 * qualifier's strip lists the hot leads nobody has put on the board yet.
 *
 * A pure render of the board the server sent: a drop asks the same rules the
 * server applies (`boardCanDrop`), and the page shows what the server saved.
 * Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §2, §3
 *
 * Compact (25 Nov 2026): the steps holding cards come first and wrap on the
 * screen — never a sideways scroll; empty steps fold into one row of chips that
 * stay drop targets (they open up while a card is dragged); the steps Nexus runs
 * by itself are one line; five hot leads, then "Show all (N)".
 * Spec: docs/superpowers/specs/2026-11-25-compact-sfs-board-design.md §3
 */

export type AddRequest = { kind: "unit" } | { kind: "deal"; contactId?: string; name?: string | null };

const LANES: { lane: Lane; title: string; add: string; tone: "mustard" | "forest" }[] = [
  { lane: "supply", title: "Supply — units", add: "Add unit", tone: "mustard" },
  { lane: "demand", title: "Demand — deals", add: "Add lead", tone: "forest" },
];

/** Whether a card may be dropped on a step: the server's own rules, before asking it. */
export function boardCanDrop(workflow: Workflow, board: Board, cardId: string, from: string, to: string): boolean {
  const card: BoardCard | undefined = [...board.units, ...board.deals].find((c) => c.id === cardId);
  if (!card || card.step !== from) return false;
  if (!boardColumns(workflow, card.kind === "unit" ? "supply" : "demand").some((s) => s.id === to)) return false;
  return moveProblem(card, to, board.today) === null;
}

export function WorkflowBoardView({
  workflow,
  board,
  audit,
  now,
  onMove,
  onOpen,
  onAdd,
  onlyMine = false,
}: {
  workflow: Workflow;
  board: Board;
  audit: WorkflowAudit | null;
  now: number;
  onMove: (cardId: string, from: string, to: string) => Promise<void>;
  onOpen: (card: BoardCard, el: HTMLElement | null) => void;
  onAdd: (request: AddRequest) => void;
  /** Staff's "Only mine" switch (compact board, 25 Nov 2026 §3.8): the viewer's own cards only. */
  onlyMine?: boolean;
}) {
  const closedId = useId();
  const waitingId = useId();
  const [allHot, setAllHot] = useState(false);
  const drag = useBoardDrag({
    canDrop: (id, from, to) => boardCanDrop(workflow, board, id, from, to),
    onDrop: onMove,
  });
  const timezone = audit?.business.timezone ?? "Asia/Dubai";
  const mine = (card: BoardCard) => isMine(card, board.viewer);
  const cards: BoardCard[] = [...board.units, ...board.deals].filter((c) => !onlyMine || mine(c));
  const waiting = [...cards].sort((a, b) => Date.parse(a.inStepSince) - Date.parse(b.inStepSince)).slice(0, 3);
  const stepName = (id: string) => workflow.steps.find((s) => s.id === id)?.name ?? id;
  const closed: [string, string][] = [
    ["Let", String(board.closed30.let)],
    ["Sold", String(board.closed30.sold)],
    ["Won", String(board.closed30.won)],
    ["Commission", aed(board.closed30.commissionAed)],
  ];

  return (
    <div className="wf-board">
      <div className="wf-board-head">
        <section className="wf-board-closed" aria-labelledby={closedId}>
          <h3 id={closedId} className="wf-h3">
            Closed in the last 30 days
          </h3>
          <dl className="wf-board-figs">
            {closed.map(([label, value]) => (
              <Fragment key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
        {waiting.length > 0 ? (
          <section className="wf-board-waiting" aria-labelledby={waitingId}>
            <h3 id={waitingId} className="wf-h3">
              Waiting longest
            </h3>
            <ol>
              {waiting.map((card) => (
                <li key={card.id}>
                  <button type="button" className="wf-board-wait" onClick={(e) => onOpen(card, e.currentTarget)}>
                    <span dir="auto">{cardTitle(card)}</span>
                    <span className="wf-board-wait-step">
                      {stepName(card.step)} · {daysInStepLabel(card.inStepSince, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>

      {LANES.map(({ lane, title, add, tone }) => {
        const { filled, empty } = splitColumns(boardColumns(workflow, lane), cards, onlyMine ? {} : board.hidden);
        const column = (step: (typeof filled)[number]) => {
          // The viewer's own cards first, each part oldest first (§3.8).
          const here = cards.filter((c) => c.step === step.id).sort((a, b) => Number(mine(b)) - Number(mine(a)));
          const hidden = !onlyMine && lane === "demand" ? board.hidden[step.id as keyof Board["hidden"]] ?? 0 : 0;
          return (
            <BoardColumn key={step.id} id={step.id} tone={tone} title={step.name} count={here.length} active={drag.over === step.id}>
              {here.map((card) => (
                <WorkflowCard
                  key={card.id}
                  card={card}
                  today={board.today}
                  now={now}
                  timezone={timezone}
                  onOpen={(el) => onOpen(card, el)}
                  handlers={drag.cardHandlers(card.id, card.step)}
                  dragging={drag.dragging === card.id}
                  published={card.kind === "unit" && isPublished(card, board)}
                  pocketInterest={
                    card.kind === "deal" &&
                    board.units.some((u) => u.pocket?.shares.some((s) => s.dealId === card.id && s.interestedAt !== null))
                  }
                  mine={mine(card)}
                />
              ))}
              {hidden > 0 ? <p className="wf-board-hidden">+{hidden} with colleagues</p> : null}
            </BoardColumn>
          );
        };
        const auto = automaticSteps(workflow, lane)
          .map((step) => {
            const first = audit ? stepFigures(step.id, audit.evidence)[0] : undefined;
            return first ? `${step.name} ${first.value}` : step.name;
          })
          .join(" · ");
        const hotShown = allHot ? board.hotWaiting : board.hotWaiting.slice(0, HOT_SHOWN);
        return (
          <section key={lane} className="wf-board-lane-wrap" aria-label={title}>
            <div className="wf-board-lane-head">
              <h2 className="wf-h2">{title}</h2>
              <button type="button" className="kit-pill" onClick={() => onAdd({ kind: lane === "supply" ? "unit" : "deal" })}>
                {add}
              </button>
            </div>

            <p className="wf-board-auto-line">
              {audit ? `Runs by itself · ${audit.period.days} days: ` : "Runs by itself: "}
              {auto}
            </p>
            {lane === "demand" && board.hotWaiting.length > 0 ? (
              <div className="wf-board-hot">
                <h4 className="wf-h3">Hot leads not on the board</h4>
                <ul>
                  {hotShown.map((hot) => (
                    <li key={hot.contactId}>
                      <span dir="auto">{hot.name ?? "A customer"}</span>
                      <button type="button" className="kit-pill quiet" onClick={() => onAdd({ kind: "deal", contactId: hot.contactId, name: hot.name })}>
                        Put on the board
                      </button>
                    </li>
                  ))}
                </ul>
                {board.hotWaiting.length > HOT_SHOWN ? (
                  <button type="button" className="wf-board-hot-more" aria-expanded={allHot} onClick={() => setAllHot((v) => !v)}>
                    {allHot ? "Show fewer" : `Show all (${board.hotWaiting.length})`}
                  </button>
                ) : null}
              </div>
            ) : null}

            {filled.length > 0 ? <div className="kit-board wf-board-lane">{filled.map(column)}</div> : null}
            {empty.length > 0 ? (
              <div className={`wf-board-empty-steps${drag.dragging ? " dragging" : ""}`}>
                <p className="wf-board-empty-label">Empty steps</p>
                <div className="wf-board-chips">{empty.map(column)}</div>
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
