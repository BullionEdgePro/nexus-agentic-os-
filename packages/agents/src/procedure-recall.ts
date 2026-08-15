import { getActiveProcedure } from "@nexus/db";
import { classifyIntent } from "./intent.js";
import { isPatternIntent, type ProcedureStep } from "@nexus/shared";

/**
 * Putting a procedure in front of the agent (F10, the half that speaks).
 *
 * Everything before this recorded and reviewed procedures. This is where one
 * finally changes a reply — so it is the first thing on this platform that lets
 * a stored row alter what a customer is told, and the caution below is
 * proportionate to that.
 *
 * ------------------------------------------------------------
 * THE INTENT USED HERE IS A PREDICTION, AND THE RECORDED ONE IS NOT
 * ------------------------------------------------------------
 *
 * `classifyIntent` reads two signals: the tools the agent invoked, and the
 * lead scorer's reading of the text. The tool signal is the better one — it is
 * a record of what happened rather than a guess about what was meant — and it
 * does not exist yet at this point in the pipeline, because the agent has not
 * replied.
 *
 * So selection runs on TEXT ALONE, which is the same half `backfill-intents`
 * replays history through, and the same half that carries ~83% of this
 * platform's traffic anyway. The consequence is real and worth naming: a
 * message the text rules read as a purchase enquiry may be recorded minutes
 * later as an inventory enquiry because `check_inventory` fired. The two
 * disagree, and the disagreement is not a bug.
 *
 * What matters is that the ACCOUNTING follows what was applied rather than what
 * was later recorded: the caller stamps the returned `procedureId` on the
 * metric row, so "this procedure was used 7 times" means seven replies it
 * genuinely shaped — not seven replies that were afterwards filed under its
 * intent.
 */

/** How much of a procedure to put in the prompt. */
const MAX_NOTE_STEPS = 8;

export interface RecalledProcedure {
  /** Stamped on the metric row by the caller. See migration 036. */
  procedureId: string;
  intent: string;
  /** The labelled block to prepend to the conversation. */
  note: string;
}

/**
 * The procedure for this message, or null.
 *
 * Null is the overwhelmingly common answer and costs one indexed read that
 * finds nothing: most businesses have no active procedure, and the two intents
 * that dominate this number's traffic can never have one.
 */
export async function recallProcedure(
  organizationId: string,
  text: string | null | undefined
): Promise<RecalledProcedure | null> {
  const { intent } = classifyIntent({ text });

  // `unknown` and `inbound_pitch` are excluded everywhere else in this system
  // and are excluded here for a sharper reason than usual. A procedure keyed on
  // `unknown` would be a method for answering messages nobody could classify —
  // which is to say, a method applied to whatever the rules failed to read.
  // That is the broadest possible blast radius for the least evidence.
  if (!isPatternIntent(intent)) return null;

  const procedure = await getActiveProcedure(organizationId, intent);
  if (!procedure) return null;

  return {
    procedureId: procedure.id,
    intent,
    note: procedureNote(procedure.steps),
  };
}

/**
 * The block the agent reads.
 *
 * Three instructions, each of which exists because of a specific way this could
 * go wrong:
 *
 *   "a default, not a script" — a procedure inferred from six conversations
 *   must not override a customer who has already told the agent which document
 *   they have. Followed rigidly, a four-step order turns a two-line enquiry
 *   into an interrogation.
 *
 *   "never override the knowledge base" — the steps are an ORDER OF WORK, not
 *   facts. A procedure saying "quote the fee" must not license inventing one.
 *   Retrieval remains the only source of substance, and a step that seems to
 *   contradict it is a stale step.
 *
 *   "do not read them out" — the failure that would be most obviously wrong to
 *   a customer: an agent announcing "step one, establish which document…", or
 *   worse, listing a business's internal method to whoever asks. This is
 *   internal working, and it is the only one of the three the customer would
 *   actually see if it were dropped.
 *
 * Written as an assistant-role note like the other enrichments, so the model
 * can tell context from instruction, and so anything wrong in it reads as
 * guidance that may be out of date rather than as ground truth.
 */
export function procedureNote(steps: ProcedureStep[]): string {
  const ordered = steps
    .slice(0, MAX_NOTE_STEPS)
    .map((step, index) => `${index + 1}. ${step.text}`)
    .join("\n");

  return (
    "How this business usually works through an enquiry like this, in order:\n" +
    `${ordered}\n` +
    "Follow this order where it fits. It is a default, not a script: skip anything the customer " +
    "has already answered, and drop it entirely if they asked something else. It never overrides " +
    "what the knowledge base says or what the customer actually told you — it is the order to " +
    "work in, not a source of facts, so it does not license quoting a price or a detail you have " +
    "not retrieved. Do not read these steps out, number them, or mention that a procedure exists."
  );
}
