/**
 * When may this platform switch a procedure on WITHOUT asking anybody?
 *
 * ============================================================
 * WHAT CHANGED, AND WHY IT IS WRITTEN DOWN HERE
 * ============================================================
 *
 * F14 recorded a refusal for weeks: "Automatic action is deliberately not taken
 * — the judgement of whether a rate is wrong belongs to someone who knows the
 * business." The owner has since asked, repeatedly and explicitly, for the
 * feature to be finished. So it is built, and this file is where the judgement
 * that used to belong to a person is written down instead.
 *
 * The refusal was right about one thing and it survives here: a rate is not a
 * reason. What makes this safe is not confidence in the inference, it is that
 * every path out of this function is narrow, reversible, and announced.
 *
 * ============================================================
 * THE FIVE RULES
 * ============================================================
 *
 * 1. ONLY WHAT THE PLATFORM INFERRED. A procedure whose `source` is `operator`
 *    was written by a person at that business. Switching on somebody's own
 *    draft is not self-improvement, it is answering for them.
 *
 * 2. A HUMAN'S "OFF" IS FINAL. If a person reviewed this and left it inactive,
 *    automation must never undo that. This is the rule that makes the feature
 *    tolerable: the owner can always win, permanently, by clicking once.
 *    Detected by `reviewedBy` being anybody other than this module's own marker.
 *
 * 3. A DISMISSAL HOLDS UNTIL THE EVIDENCE GENUINELY MOVES. `dismissedEvidence`
 *    records how much evidence existed when somebody said no. The existing
 *    inference writer already uses that to stay quiet; the same bar applies
 *    here, doubled, because re-proposing is cheap and re-activating is not.
 *
 * 4. AN EVIDENCE FLOOR, and it is the platform's own. Predictive BI refuses to
 *    show a number without four weeks of history and a backtest; the shared
 *    brain refuses to pool below two tenants and twenty samples. A procedure
 *    drawn from three conversations is an anecdote with a schema.
 *
 * 5. IT IS NEVER SILENT. The caller raises a finding for every activation. A
 *    platform that changes how it answers customers and does not say so is the
 *    thing the original refusal was actually protecting against.
 *
 * A rule that cannot be checked is a rule nobody has. This is a pure function
 * over one record so the suite can prove each rule with a procedure that breaks
 * it — the same reason `policyFault` is shaped this way.
 */
import type { ProcedureRecord } from "./procedures.js";

/**
 * Written into `reviewed_by` when this module activates something.
 *
 * Load-bearing in two directions: it tells a person reading the review column
 * that no human approved this, and it is how rule 2 distinguishes "nobody has
 * looked" from "a person deliberately left this off".
 */
export const AUTO_REVIEWER = "auto:self-improvement";

/**
 * How many well-handled conversations a procedure must be drawn from.
 *
 * Twenty, matching the shared brain's sample floor rather than inventing a
 * second number for the same kind of judgement. The platform already decided
 * once what "enough conversations to generalise from" means.
 */
export const AUTO_ACTIVATION_FLOOR = 20;

export interface AutoActivationDecision {
  activate: boolean;
  /** Always present. The audit trail and the finding both quote it. */
  reason: string;
}

/**
 * Whether one inferred procedure may be switched on without a person.
 *
 * Returns a reason either way, because "why did this turn on" and "why has this
 * not turned on" are both questions somebody will ask, and a boolean answers
 * neither.
 */
export function autoActivationDecision(
  procedure: Pick<
    ProcedureRecord,
    | "source"
    | "isActive"
    | "derivedFromCount"
    | "dismissedAt"
    | "dismissedEvidence"
    | "reviewedAt"
    | "reviewedBy"
  >,
  floor: number = AUTO_ACTIVATION_FLOOR
): AutoActivationDecision {
  if (procedure.isActive) {
    return { activate: false, reason: "already active" };
  }

  // Rule 1.
  if (procedure.source !== "inferred") {
    return {
      activate: false,
      reason: "written by somebody at this business — switching on their own draft is not this platform's decision",
    };
  }

  // Rule 2. The one that makes the rest tolerable.
  if (procedure.reviewedBy && procedure.reviewedBy !== AUTO_REVIEWER) {
    return {
      activate: false,
      reason: `${procedure.reviewedBy} reviewed this and left it off, and that decision stands`,
    };
  }

  // Rule 3.
  if (procedure.dismissedAt) {
    const bar = (procedure.dismissedEvidence ?? 0) * 2;
    if (procedure.derivedFromCount < bar) {
      return {
        activate: false,
        reason:
          `dismissed at ${procedure.dismissedEvidence ?? 0} conversations and now drawn from ` +
          `${procedure.derivedFromCount}; the evidence has not doubled, so the dismissal holds`,
      };
    }
  }

  // Rule 4.
  if (procedure.derivedFromCount < floor) {
    return {
      activate: false,
      reason: `drawn from ${procedure.derivedFromCount} conversations, and the floor is ${floor}`,
    };
  }

  return {
    activate: true,
    reason:
      `drawn from ${procedure.derivedFromCount} well-handled conversations, above the floor of ` +
      `${floor}, inferred rather than authored, and nobody has reviewed it`,
  };
}

/** Every procedure that may be switched on, with the reason each qualified. */
export function autoActivationCandidates(
  procedures: ProcedureRecord[],
  floor: number = AUTO_ACTIVATION_FLOOR
): Array<{ procedure: ProcedureRecord; reason: string }> {
  const chosen: Array<{ procedure: ProcedureRecord; reason: string }> = [];
  const claimed = new Set<string>();

  for (const procedure of procedures) {
    const decision = autoActivationDecision(procedure, floor);
    if (!decision.activate) continue;

    // ONE PER SITUATION, decided here rather than left to the unique index.
    //
    // `procedures_one_active_per_intent` would reject the second with a
    // constraint violation, which is a correct database and a poor decision: it
    // would activate whichever the query happened to return first. Two drafts
    // for one situation means the evidence is split, and neither should go live
    // until somebody looks.
    const key = `${procedure.organizationId}:${procedure.intentCategory}:${procedure.language}`;
    if (claimed.has(key)) {
      const first = chosen.findIndex((c) => {
        const p = c.procedure;
        return `${p.organizationId}:${p.intentCategory}:${p.language}` === key;
      });
      if (first !== -1) chosen.splice(first, 1);
      continue;
    }
    claimed.add(key);
    chosen.push({ procedure, reason: decision.reason });
  }

  // An intent that had two candidates has none: the splice above removed the
  // first when the second arrived, and `claimed` stops a third re-adding it.
  return chosen;
}

/** Is this procedure active because a person said so, or because the platform did? */
export function wasActivatedAutomatically(
  procedure: Pick<ProcedureRecord, "isActive" | "reviewedBy">
): boolean {
  return procedure.isActive && procedure.reviewedBy === AUTO_REVIEWER;
}
