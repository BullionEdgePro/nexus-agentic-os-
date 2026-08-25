/**
 * How long an acceptance lasts.
 *
 * ============================================================
 * WHY "FOREVER" IS NOT ON THE MENU
 * ============================================================
 *
 * `a-dismissal-lapses-when-the-finding-does` opens by naming the failure this
 * module exists to close: "Get this wrong and dismissal is a permanent silent
 * mute that looks like a working feature." It then tied the lapse to one
 * predicate — the finding resolving and coming back — which is right for
 * everything that ends, and is exactly a permanent mute for everything that
 * does not.
 *
 * Production proved the second case on 2026-08-25. Four findings stood, all
 * four accepted, and the urgent one had been accepted at roughly 118 hours of a
 * customer waiting. It was 142.3 hours by the time anybody looked again, still
 * climbing, and it could never re-surface: the condition had been continuously
 * true the whole time, so the only predicate that clears an acceptance had
 * never fired. The deck said, honestly and uselessly, that four findings were
 * still true and had been accepted.
 *
 * So an acceptance now says how long it is for. Not because a person's judgement
 * expires — theirs is usually right — but because a judgement is made against a
 * situation, and the situation moves. "I have seen that somebody is waiting"
 * said on Monday is not a statement about Friday.
 *
 * ============================================================
 * WHY THESE THREE, AND WHY A MONTH IS ONE OF THEM
 * ============================================================
 *
 * The three findings accepted alongside that one were "booking is configured
 * and nobody is on a rota" at three firms — which, as the older test says, "may
 * well be a decision already made". Re-raising that every morning is nagging,
 * and a deck that nags is one people stop reading, which is the same disease by
 * a different route.
 *
 * A month is long enough that a settled decision stays quiet, and short enough
 * that it is reviewed while the people who made it still remember why. Nothing
 * here silences anything past that, and the deck shows the date, so an
 * acceptance is a thing with an end that a person can see rather than a hole
 * they have to remember exists.
 */

export interface DismissalHorizon {
  /** What the API and the browser pass. Stable; the label is not. */
  key: string;
  /** What the button says. Written as the person's sentence, not the system's. */
  label: string;
  /** Hours. Turned into an interval by the writer, never by string building. */
  hours: number;
  /** Shown under the choice, so the consequence is read before it is taken. */
  describes: string;
}

export const DISMISSAL_HORIZONS: readonly DismissalHorizon[] = [
  {
    key: "day",
    label: "for a day",
    hours: 24,
    describes: "It comes back tomorrow if it is still true.",
  },
  {
    key: "week",
    label: "for a week",
    hours: 24 * 7,
    describes: "Long enough to get to it, short enough not to forget it.",
  },
  {
    key: "month",
    label: "for a month",
    hours: 24 * 30,
    describes: "For something already decided. It is still reviewed, just not soon.",
  },
] as const;

/** The one used when a caller does not choose. Deliberately the middle. */
export const DEFAULT_DISMISSAL_HORIZON = "week";

/**
 * The horizon for a key, or a sentence saying why not.
 *
 * Returns a refusal rather than falling back to the default, because a browser
 * sending a key this does not know is a browser and a server that disagree
 * about the menu, and quietly accepting it would silence a finding for a length
 * of time nobody chose.
 */
export function dismissalHorizon(
  key: unknown
): { horizon: DismissalHorizon } | { reason: string } {
  if (typeof key !== "string" || !key) {
    return { reason: "Say how long this is accepted for." };
  }
  const horizon = DISMISSAL_HORIZONS.find((h) => h.key === key);
  if (!horizon) {
    const offered = DISMISSAL_HORIZONS.map((h) => h.key).join(", ");
    return { reason: `"${key}" is not one of the lengths on offer (${offered}).` };
  }
  return { horizon };
}

/**
 * Has this acceptance run out?
 *
 * Pure, and separate from the SQL that does the same thing in the sweep, so the
 * rule can be stated once in a test rather than inferred from a `case`
 * expression. Null means an acceptance made before horizons existed — those are
 * given one by migration 065 rather than being read as forever here, and this
 * returns false for them so a row the migration has not reached yet is not
 * silently un-accepted by a screen.
 */
export function dismissalHasLapsed(
  dismissedUntil: string | Date | null | undefined,
  now: Date = new Date()
): boolean {
  if (!dismissedUntil) return false;
  const until = dismissedUntil instanceof Date ? dismissedUntil : new Date(dismissedUntil);
  if (Number.isNaN(until.getTime())) return false;
  return until.getTime() <= now.getTime();
}
