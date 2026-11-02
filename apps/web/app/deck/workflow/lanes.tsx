import type { CSSProperties, ReactNode } from "react";
import { stepStatus, type Lane, type StepStatus, type Workflow, type WorkflowAudit, type WorkflowStep } from "@nexus/shared";
import { StatusCard } from "../../kit/status-card";
import type { Tone } from "@/lib/kit/wait-band";
import { stepFigures } from "@/lib/workflow/step-figures";

/**
 * The boss's workflow drawn live (2 Nov 2026, SFS workflow audit): two lanes
 * of cards, each in its status's colour, with arrows that keep the branches
 * ("not now" → Nurture, the rent / sale split, "cold" → Cold lead). On a
 * desktop the lanes are rows that scroll sideways inside their box; on a phone
 * each lane is a list with downward arrows and its branches indented in pairs.
 * Spec: docs/superpowers/specs/2026-11-02-sfs-audit-design.md §4.3
 */

export const STATUS_LOOK: Record<StepStatus, { tone: Tone; className?: string; word: string; chip: string }> = {
  working: { tone: "forest", word: "Working", chip: "Working" },
  idle: { tone: "paper", className: "wf-idle", word: "Idle", chip: "Idle" },
  partly: { tone: "mustard", word: "Partly", chip: "Partly" },
  not_tracked: { tone: "paper", className: "wf-untracked", word: "Not tracked in Nexus yet", chip: "Not tracked yet" },
};

const LANE_TITLE: Record<Lane, string> = {
  supply: "Supply — owner to live listing",
  demand: "Demand — lead to closed deal",
};

/** Rent and sale deals aren't recorded, but won labels are: one note under both (spec §4.2). */
export const WON_NOTE_UNDER = ["D7", "D8"];
export const wonNote = (won: number) => `Won (labelled) in this period: ${won.toLocaleString("en-GB")} — rent or sale isn't recorded`;

// The drawing's fixed measures, in px: a card row, the gap between rows, and
// the strip between columns that holds the arrows.
const ROW = 188;
const ROW_GAP = 18;
const LINK = 30;

type Placed = { step: WorkflowStep; col: number; row: number; branch?: string };

/**
 * Where each step of a lane sits: its column is its distance from the lane's
 * first step (the longest way there), and a column holding two steps puts the
 * main path on top and a labelled branch ("not now") below. Pure.
 */
export function laneLayout(steps: WorkflowStep[]): { cells: Placed[]; cols: number; rows: number } {
  const ids = new Set(steps.map((s) => s.id));
  const depth = new Map<string, number>();
  const branch = new Map<string, string>();
  steps.forEach((step, i) => {
    if (i === 0) depth.set(step.id, 0);
    const d = depth.get(step.id) ?? 0;
    for (const edge of step.next) {
      if (!ids.has(edge.to)) continue;
      depth.set(edge.to, Math.max(depth.get(edge.to) ?? 0, d + 1));
      if (edge.label) branch.set(edge.to, edge.label);
    }
  });
  const byCol = new Map<number, WorkflowStep[]>();
  for (const step of steps) {
    const col = depth.get(step.id) ?? 0;
    byCol.set(col, [...(byCol.get(col) ?? []), step]);
  }
  const cells: Placed[] = [];
  for (const [col, list] of [...byCol].sort((a, b) => a[0] - b[0])) {
    const ordered = [...list.filter((s) => !branch.has(s.id)), ...list.filter((s) => branch.has(s.id))];
    ordered.forEach((step, row) => cells.push({ step, col, row, branch: branch.get(step.id) }));
  }
  return {
    cells,
    cols: Math.max(...cells.map((c) => c.col)) + 1,
    rows: Math.max(...cells.map((c) => c.row)) + 1,
  };
}

const mid = (row: number) => row * (ROW + ROW_GAP) + ROW / 2;

/** An arrow across the strip from one row to another: straight, or an elbow with rounded corners. */
function arrowPath(from: number, to: number): string {
  const y0 = mid(from);
  const y1 = mid(to);
  if (y0 === y1) return `M0 ${y0} H${LINK - 1}`;
  const m = LINK / 2;
  const r = 6;
  const s = y1 > y0 ? 1 : -1;
  return `M0 ${y0} H${m - r} Q${m} ${y0} ${m} ${y0 + s * r} V${y1 - s * r} Q${m} ${y1} ${m + r} ${y1} H${LINK - 1}`;
}

const headPath = (to: number) => `M${LINK - 7} ${mid(to) - 4.5} L${LINK - 1} ${mid(to)} L${LINK - 7} ${mid(to) + 4.5}`;

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

function StepCard({
  step,
  evidence,
  onOpen,
}: {
  step: WorkflowStep;
  evidence: WorkflowAudit["evidence"];
  onOpen: (stepId: string, card: HTMLElement) => void;
}) {
  const status = stepStatus(step, evidence);
  const look = STATUS_LOOK[status];
  const figures = stepFigures(step.id, evidence);
  const quiet = figures.length > 0 && figures.every((f) => f.value === "0");
  return (
    <StatusCard
      tone={look.tone}
      className={`wf-card${look.className ? ` ${look.className}` : ""}`}
      eyebrow={step.tag}
      title={step.name}
      subtitle={step.subtitle}
      label={`${step.tag} ${step.name}: ${look.word}. Open the step.`}
      onOpen={(card) => onOpen(step.id, card)}
      footer={
        <>
          <span className="wf-chip">{look.chip}</span>
          {status === "not_tracked" ? (
            step.missing ? <span className="wf-needs">Needs {lowerFirst(step.missing)}</span> : null
          ) : quiet ? (
            <span className="wf-quiet">nothing in this period</span>
          ) : (
            figures.slice(0, 3).map((f) => (
              <span className="wf-fig" key={f.label}>
                <span dir="auto">{f.label}</span>
                <b>{f.value}</b>
              </span>
            ))
          )}
        </>
      }
    />
  );
}

function LaneDrawing({
  lane,
  index,
  steps,
  evidence,
  onOpen,
}: {
  lane: Lane;
  index: number;
  steps: WorkflowStep[];
  evidence: WorkflowAudit["evidence"];
  onOpen: (stepId: string, card: HTMLElement) => void;
}) {
  const { cells, cols, rows } = laneLayout(steps);
  const at = new Map(cells.map((c) => [c.step.id, c]));
  const status = new Map(steps.map((s) => [s.id, stepStatus(s, evidence)]));
  const noteCol = cells.find((c) => WON_NOTE_UNDER.includes(c.step.id))?.col;
  const height = rows * ROW + (rows - 1) * ROW_GAP;
  const grid: CSSProperties = {
    gridTemplateColumns: `${Array.from({ length: cols }, () => "minmax(148px, 1fr)").join(` ${LINK}px `)}`,
    gridTemplateRows: `repeat(${rows}, ${ROW}px)${noteCol !== undefined ? " auto" : ""}`,
  };

  const out: ReactNode[] = [];
  for (let col = 0; col < cols; col += 1) {
    const here = cells.filter((c) => c.col === col);
    for (const cell of here) {
      out.push(
        <div
          key={cell.step.id}
          className={`wf-cell${here.length > 1 ? " wf-pair" : ""}`}
          data-step={cell.step.id}
          style={{ gridColumn: col * 2 + 1, gridRow: cell.row + 1 }}
        >
          {cell.branch ? <span className="wf-edge-label">{cell.branch}</span> : null}
          <StepCard step={cell.step} evidence={evidence} onOpen={onOpen} />
        </div>
      );
      if (cell.step.id === WON_NOTE_UNDER[WON_NOTE_UNDER.length - 1] && noteCol !== undefined) {
        out.push(
          <p key="won-note" className="wf-note" style={{ gridColumn: noteCol * 2 + 1, gridRow: rows + 1 }}>
            {wonNote(evidence.won)}
          </p>
        );
      }
    }
    const edges = here.flatMap((c) =>
      c.step.next.flatMap((edge) => {
        const target = at.get(edge.to);
        return target ? [{ from: c, to: target }] : [];
      })
    );
    if (col < cols - 1 && edges.length) {
      out.push(
        <svg
          key={`link-${col}`}
          className="wf-link"
          aria-hidden="true"
          width={LINK}
          height={height}
          viewBox={`0 0 ${LINK} ${height}`}
          style={{ gridColumn: col * 2 + 2, gridRow: `1 / span ${rows}`, "--i": col } as CSSProperties}
        >
          {edges.map(({ from, to }) => {
            const d = arrowPath(from.row, to.row);
            // The pulse rides only a path from a Working card to a step Nexus tracks.
            const flowing = status.get(from.step.id) === "working" && status.get(to.step.id) !== "not_tracked";
            return (
              <g key={`${from.step.id}-${to.step.id}`}>
                <path className="wf-arrow" d={d} pathLength={100} />
                <path className="wf-head" d={headPath(to.row)} />
                {flowing ? <path className="wf-pulse" d={d} pathLength={100} /> : null}
              </g>
            );
          })}
        </svg>
      );
    }
  }

  return (
    <section className="wf-lane" aria-label={LANE_TITLE[lane]} style={{ "--lane": index } as CSSProperties}>
      <h3 className="wf-lane-title">{LANE_TITLE[lane]}</h3>
      <div className="wf-scroll">
        <div className="wf-grid" style={grid}>
          {out}
        </div>
      </div>
    </section>
  );
}

export function WorkflowLanes({
  workflow,
  evidence,
  onOpen,
}: {
  workflow: Workflow;
  evidence: WorkflowAudit["evidence"];
  onOpen: (stepId: string, card: HTMLElement) => void;
}) {
  const lanes: Lane[] = ["supply", "demand"];
  return (
    <div className="wf-lanes">
      {lanes.map((lane, index) => {
        const steps = workflow.steps.filter((s) => s.lane === lane);
        return steps.length ? (
          <LaneDrawing key={lane} lane={lane} index={index} steps={steps} evidence={evidence} onOpen={onOpen} />
        ) : null;
      })}
    </div>
  );
}
