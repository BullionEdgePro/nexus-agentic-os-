/**
 * How good the lead scorer actually is, and when it is honest to say.
 *
 * ============================================================
 * WHY THIS REFUSES
 * ============================================================
 *
 * Pure, and it refuses for the same reason the forecast does: a number computed
 * from four labels has the shape of an accuracy figure and none of the content.
 * Somebody would read "75% of high-priority leads were worth it" off three
 * labels and a coin toss, and act on it.
 *
 * So there is a floor, and below it the answer is the sentence saying why --
 * which is also the sentence that tells somebody what to do about it, since the
 * fix for "not enough labels" is to label a few more.
 *
 * ============================================================
 * WHY TWO NUMBERS, NOT ONE
 * ============================================================
 *
 * A single "accuracy" would hide the failure that costs money. The scorer is a
 * ranking, and a ranking fails in two directions that are not equally bad:
 *
 *   FALSE ALARM  it shouted about something that was not worth it. Costs
 *                somebody a minute.
 *   MISS         it stayed quiet about something that WAS worth it, so nobody
 *                looked. Costs the business the lead.
 *
 * Averaging them together produces a figure that looks fine while every miss is
 * a customer who went elsewhere. They are reported separately and the miss rate
 * is named as the expensive one.
 */

/** Labels needed, per side, before either figure is published. */
export const MIN_LABELS_PER_SIDE = 8;

/** The priorities the scorer means as "somebody should look at this". */
const LOUD = new Set(["high", "urgent"]);

export interface LabelledAssessment {
  priority: string;
  worthAttention: boolean;
}

export interface ScorerAccuracy {
  /** Labels available, both sides together. */
  labelled: number;
  /**
   * Of the leads it called high or urgent, the share that were worth it.
   * Null until there are enough of them to mean anything.
   */
  falseAlarmRate: number | null;
  /**
   * Of the leads it called low or normal, the share that WERE worth it -- the
   * ones nobody was told to look at. The expensive failure.
   */
  missRate: number | null;
  loudCount: number;
  quietCount: number;
  /** Why a figure is missing, in words somebody can act on. Null when both are present. */
  blockedBecause: string | null;
}

export function scorerAccuracy(labels: readonly LabelledAssessment[]): ScorerAccuracy {
  const loud = labels.filter((l) => LOUD.has(l.priority));
  const quiet = labels.filter((l) => !LOUD.has(l.priority));

  const falseAlarms = loud.filter((l) => !l.worthAttention).length;
  const misses = quiet.filter((l) => l.worthAttention).length;

  const enoughLoud = loud.length >= MIN_LABELS_PER_SIDE;
  const enoughQuiet = quiet.length >= MIN_LABELS_PER_SIDE;

  // The sentence names the side that is short, and how short, because "not
  // enough data" tells nobody whether that means two more or two hundred.
  let blockedBecause: string | null = null;
  if (!enoughLoud && !enoughQuiet) {
    blockedBecause =
      `Not judged yet. Mark ${MIN_LABELS_PER_SIDE - loud.length} more high-priority leads and ` +
      `${MIN_LABELS_PER_SIDE - quiet.length} more ordinary ones as worth it or not.`;
  } else if (!enoughLoud) {
    blockedBecause =
      `Only ${loud.length} high-priority leads have been marked, so how often it shouts about ` +
      `nothing cannot be said yet.`;
  } else if (!enoughQuiet) {
    blockedBecause =
      `Only ${quiet.length} ordinary leads have been marked, so how often it MISSES something ` +
      `cannot be said yet — and that is the one that costs money.`;
  }

  return {
    labelled: labels.length,
    falseAlarmRate: enoughLoud ? falseAlarms / loud.length : null,
    missRate: enoughQuiet ? misses / quiet.length : null,
    loudCount: loud.length,
    quietCount: quiet.length,
    blockedBecause,
  };
}

export const LEAD_OUTCOMES = ["won", "lost", "no_reply", "not_a_lead"] as const;
export type LeadOutcome = (typeof LEAD_OUTCOMES)[number];

/** An outcome this does not know is refused rather than stored as free text. */
export function isLeadOutcome(value: unknown): value is LeadOutcome {
  return typeof value === "string" && (LEAD_OUTCOMES as readonly string[]).includes(value);
}
