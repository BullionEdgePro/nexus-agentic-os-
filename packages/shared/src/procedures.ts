/**
 * What a procedure step IS — one definition, used by everything that writes one.
 *
 * `procedures.steps` is jsonb, which means the database will accept any shape at
 * all. Three writers touch it: the inference writer, the review screen's edit
 * box, and whatever comes next. If each decided its own shape — a bare string
 * here, `{step: "..."}` there, `{text, tool}` later — the reader that finally
 * puts these in front of the agent would have to guess, and a step it failed to
 * recognise would simply not be spoken. Silently, in the middle of a procedure
 * that reads as complete on the screen.
 *
 * So the shape is decided once, here, in the same package and for the same
 * reason as the intent vocabulary next door.
 */

/**
 * One instruction, in the imperative, as the business would say it.
 *
 * An object rather than a bare string, because migration 033 chose jsonb
 * precisely so a step could later carry structure — a tool to call, a field to
 * collect — without a migration. Starting with a string would mean that day
 * arrives as a format change across three writers and every stored row.
 */
export interface ProcedureStep {
  text: string;
}

/**
 * Eight, matching the `procedures_steps_bounded` constraint in migration 034.
 *
 * A procedure is a method somebody can hold in their head. Past eight steps it
 * is a transcript that has been mistaken for one — and once active it sits in
 * the agent's prompt, where length is not free: it crowds out the retrieved
 * knowledge that actually answers the question.
 */
export const MAX_PROCEDURE_STEPS = 8;

/** Long enough for a sentence, short enough that a step cannot become a script. */
export const MAX_STEP_CHARS = 200;

export type ParsedSteps =
  | { ok: true; steps: ProcedureStep[] }
  | { ok: false; error: string };

/**
 * Turn anything into steps, or say why not.
 *
 * FORGIVING ON THE WAY IN, STRICT ON THE WAY TO STORAGE. Callers hand this three
 * different things — a model's JSON, a textarea split on newlines, a row read
 * back from jsonb — and all three legitimately arrive as bare strings sometimes.
 * Normalising them here means storage only ever holds one shape.
 *
 * The errors are written to be shown to a person, because one caller is a form.
 */
export function parseProcedureSteps(input: unknown): ParsedSteps {
  if (!Array.isArray(input)) {
    return { ok: false, error: "A procedure is a list of steps." };
  }

  const steps: ProcedureStep[] = [];
  for (const raw of input) {
    const text =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && typeof (raw as ProcedureStep).text === "string"
          ? (raw as ProcedureStep).text
          : null;

    if (text === null) {
      return { ok: false, error: "Every step must be a line of text." };
    }

    const trimmed = text.trim().replace(/\s+/g, " ");
    // Blank lines are dropped rather than refused: a textarea ending in a
    // newline is not a mistake anybody should have to fix.
    if (!trimmed) continue;
    if (trimmed.length > MAX_STEP_CHARS) {
      return {
        ok: false,
        error: `A step must be under ${MAX_STEP_CHARS} characters. Split the long one in two.`,
      };
    }
    steps.push({ text: trimmed });
  }

  if (steps.length === 0) {
    return { ok: false, error: "A procedure needs at least one step." };
  }
  if (steps.length > MAX_PROCEDURE_STEPS) {
    return {
      ok: false,
      error: `A procedure is at most ${MAX_PROCEDURE_STEPS} steps. Longer than that is a transcript, not a method.`,
    };
  }

  return { ok: true, steps };
}

/**
 * Whether two procedures say the same thing.
 *
 * Used by the writer to decide whether a fresh inference is news. Without it,
 * every nightly run would stamp a "new suggestion" badge on a screen where
 * nothing had changed, and the badge would stop meaning anything by the end of
 * the week.
 *
 * Compared on normalised text, so a difference in spacing or capitalisation is
 * not treated as a change of method.
 */
export function procedureStepsEqual(a: ProcedureStep[], b: ProcedureStep[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((step, index) => normaliseStep(step.text) === normaliseStep(b[index].text));
}

function normaliseStep(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
