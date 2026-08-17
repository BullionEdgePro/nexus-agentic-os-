import { getActiveProcedure, getSharedGuidance } from "@nexus/db";
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
 *
 * ------------------------------------------------------------
 * TWO SOURCES NOW, AND ONLY ONE OF THEM WAS SWITCHED ON BY ANYBODY
 * ------------------------------------------------------------
 *
 * A business's own active procedure is the first answer and always wins. Where
 * there is none, F5's pooled patterns can supply a weaker note — the half of the
 * Neural Brain that reaches a customer, and the only thing on this platform that
 * shapes a reply without a person at that business having approved it.
 *
 * That is a real departure from how everything else here works, so it is fenced
 * accordingly: it speaks only where the business has nothing of its own, only
 * from patterns two businesses and twenty conversations deep, only where those
 * conversations usually ended with a person, and it carries no numbers and no
 * mention of other businesses into the prompt. It also stamps NO procedure id,
 * because no procedure was applied.
 */

/** How much of a procedure to put in the prompt. */
const MAX_NOTE_STEPS = 8;

export interface RecalledProcedure {
  /**
   * Stamped on the metric row by the caller. See migration 036.
   *
   * NULL FOR POOLED GUIDANCE, and that is load-bearing rather than tidy typing.
   * `times_applied` is recomputed from these stamps, so a pooled note carrying
   * a borrowed id would inflate some real procedure's usage with conversations
   * it never shaped — and the whole point of recomputing rather than
   * incrementing was that the number stays auditable back to the conversations
   * behind it. A pooled note shaped a reply; no procedure did.
   */
  procedureId: string | null;
  intent: string;
  /** Where the guidance came from. `pooled` never counts toward any procedure. */
  source: "business" | "pooled";
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
  if (procedure) {
    return {
      procedureId: procedure.id,
      intent,
      source: "business",
      note: procedureNote(procedure.steps),
    };
  }

  // ------------------------------------------------------------
  // NOTHING OF THIS BUSINESS'S OWN — ASK THE POOL (F5)
  // ------------------------------------------------------------
  //
  // This is the half of the Neural Brain that reaches a customer, and it only
  // ever runs where a business has nothing of its own for this situation. That
  // ordering is the entire safety argument: a procedure somebody at this
  // business wrote, or read and switched on, always wins, and pooled guidance
  // is what F5 was described as being for — "so a tenant with no history can
  // still be told that a given kind of enquiry usually needs a human".
  //
  // WHAT CROSSES, AND WHAT CANNOT. `getSharedGuidance` is reused rather than
  // re-queried deliberately: it is the one place the two-tenant filter and the
  // 20-sample floor live, and a second query here would be a second place to
  // forget them. Its own comment is blunt about why the filter exists — without
  // it "the first careless caller presents one tenant's own history back to it
  // as platform knowledge, and nobody downstream could tell". This is that
  // careless caller, so it does not get to set its own thresholds.
  //
  // NO NUMBERS REACH THE PROMPT. The rate decided whether to speak; it is not
  // repeated to the model, because a model handed "78%" will eventually hand it
  // to a customer, and "most people in your position end up needing a lawyer"
  // is a sentence no business here would choose to send. The pattern is also
  // never named as coming from other businesses, which the customer has no
  // standing to be told and the agent no reason to know.
  //
  // Fails soft. A pooled read that throws must not cost a reply its note or its
  // life — the business had no procedure either way, so the honest degradation
  // is exactly the behaviour before F5 was wired in at all.
  try {
    // Almost always null, and will be for some time: it takes two businesses
    // and twenty conversations on one kind of enquiry, and four of the five
    // here have never had a customer.
    if (!selectPooledGuidance(await getSharedGuidance(), intent)) return null;
    return { procedureId: null, intent, source: "pooled", note: POOLED_NOTE };
  } catch {
    return null;
  }
}

/**
 * Whether the pool has anything worth saying about this kind of enquiry.
 *
 * Pulled out as a pure function so it can be tested with actual patterns rather
 * than by matching the source that implements it. Everything it decides is
 * invisible from the outside — a wrong language match, an off-by-one on the
 * floor, or picking the first row regardless of intent would all produce a note
 * that looks perfectly reasonable in front of a customer and is about something
 * else entirely.
 */
export function selectPooledGuidance(
  patterns: { intentCategory: string; language: string; escalationRate: number }[],
  intent: string
): boolean {
  const match = patterns.find(
    (pattern) => pattern.intentCategory === intent && pattern.language === POOLED_LANGUAGE
  );
  if (!match) return false;
  return match.escalationRate >= POOLED_ESCALATION_FLOOR;
}

/**
 * Matches `getActiveProcedure`'s default rather than the customer's language.
 *
 * A known limit, written down rather than hidden: procedures are English-only in
 * practice today, so pooling in any other language would offer guidance where
 * the business could not have had a procedure anyway. When procedures gain a
 * language, this and that default move together or they will disagree.
 */
const POOLED_LANGUAGE = "en";

/**
 * How often the platform must see this end with a person before saying so.
 *
 * A pattern that escalates 20% of the time is a kind of enquiry usually handled
 * fine, and telling the agent to prepare a handoff for it would make it worse at
 * the four-in-five it could have answered. The threshold is about usefulness,
 * not confidence — `getSharedGuidance` already refused anything thin.
 */
const POOLED_ESCALATION_FLOOR = 0.5;

/**
 * What the agent is told when only the pool has anything to say.
 *
 * Deliberately weaker than a procedure and shaped as preparation rather than
 * instruction. It cannot say what to establish first, because it does not know
 * this business — it knows only that enquiries like this usually end with a
 * person, and the useful consequence of that is arriving at the handover with
 * the details already gathered rather than making the customer repeat them.
 *
 * The last line matters most: without it, "this usually needs a person" reads to
 * a model as licence to stop trying.
 */
const POOLED_NOTE =
  "Enquiries like this one usually end up with a colleague rather than being resolved in chat. " +
  "That is a tendency across businesses like this one, not a fact about this customer, and it is " +
  "not a reason to hand over early or to say any of this out loud. Answer normally and as fully " +
  "as the knowledge base allows — but while you do, make sure the specifics a colleague would " +
  "need are actually asked for, so nobody has to start again if it does reach one.";

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
