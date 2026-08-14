import { scoreLead } from "@nexus/leads";
import type { IntentCategory } from "@nexus/shared";

/**
 * What an inbound message was about, for analytics and for F5.
 *
 * NO NEW MODEL CALL, AND NO SECOND KEYWORD LIST.
 *
 * Both were tempting and both are wrong here. A per-message classification call
 * would add inference cost and latency to the reply path for a number nobody
 * reads in real time — and it would add a failure mode this system has already
 * been bitten by twice: a retired model id returns 404, the caller catches it,
 * and the result is indistinguishable from a quiet week. Analytics that can
 * break silently are worse than analytics that are coarse.
 *
 * A second hand-written keyword list would be worse still. Lead scoring already
 * owns ~150 bilingual phrases, precedence rules, and a spam detector tuned
 * against this number's real traffic. A parallel list would start as a copy,
 * drift within weeks, and the drift would show up as F5 patterns splitting in
 * half — the exact failure `@nexus/shared/intents.ts` exists to prevent. One
 * vocabulary means one place to be wrong.
 *
 * So classification is a mapping over signals this system already computes:
 * the tool the agent chose, and the lead scorer's category.
 */

/**
 * The tool the agent actually invoked.
 *
 * The strongest signal available and free: a tool call is a record of what
 * happened rather than a guess about what was meant. Moved here from
 * `processor.ts` so the tool mapping and the text mapping land in one file and
 * can be read against each other — kept apart, the two drift into naming the
 * same intent differently.
 */
const TOOL_INTENT: Record<string, IntentCategory> = {
  check_inventory: "inventory_inquiry",
  book_appointment: "appointment_booking",
  // Asking for times IS the booking intent, whether or not the customer went on
  // to take one. Left out, every conversation that got as far as being offered a
  // slot and then stalled would be filed as a general enquiry — which hides the
  // one number worth watching on a new feature: how many people were offered an
  // appointment and did not take it.
  check_availability: "appointment_booking",
  search_knowledge: "knowledge_lookup",
};

/**
 * The lead scorer's category, for the ~83% of messages where no tool fires.
 *
 * `general_inquiry` IS DELIBERATELY ABSENT, and that is the most important line
 * in this file.
 *
 * In `scoreLead`, `general_inquiry` is the initial value of `bestCategory` — it
 * is what you get when no rule matched at all. For lead PRIORITY that is a fine
 * default: an unmatched message is a low-priority lead. For F5 it is a lie with
 * a friendly name. Mapping it through would pool every message the rules could
 * not read into one large, confident-looking pattern whose actual content is
 * "we could not tell", and — because unmatched messages are the majority — that
 * pattern would be the first to cross the 20-sample threshold and the first
 * thing the Neural Brain ever said.
 *
 * An unmapped category therefore falls through to `unknown`, which is excluded
 * from pooling and counted as a coverage miss. The rules being unable to read a
 * message is a fact about the rules, and it should be reported as one.
 */
const LEAD_CATEGORY_INTENT: Record<string, IntentCategory> = {
  purchase_intent: "purchase_inquiry",
  // Bulk and wholesale are purchase enquiries with volume attached. Folded in
  // rather than given their own intent: splitting them would halve both samples
  // to make a distinction F5 cannot act on.
  high_value: "purchase_inquiry",
  booking_intent: "appointment_booking",
  legal_inquiry: "legal_inquiry",
  complaint: "complaint",
  inbound_pitch: "inbound_pitch",
};

export interface IntentClassification {
  intent: IntentCategory;
  /** Which signal decided it. Carried for logs and for the backfill's report. */
  source: "tool" | "text" | "none";
}

export interface ClassifyIntentInput {
  /** The customer's inbound text. Absent for media-only messages. */
  text?: string | null;
  /** Tools the agent invoked while answering, if it answered. */
  toolCalls?: ReadonlyArray<{ name: string }>;
}

/**
 * Classify one inbound message.
 *
 * Pure and synchronous — no I/O, no model, no latency on the reply path — so
 * the whole policy is unit-testable and the backfill can replay history through
 * the identical function rather than a reimplementation of it.
 *
 * Never returns null. A message it cannot place is `unknown`, which is a
 * classification; null now means the classifier did not run, which is a defect.
 * See `INTENT_NULL_MEANS_CLASSIFIER_DID_NOT_RUN`.
 */
export function classifyIntent(input: ClassifyIntentInput): IntentClassification {
  const text = input.text?.trim() ?? "";
  const fromText = text ? LEAD_CATEGORY_INTENT[scoreLead({ text }).category] : undefined;

  // A COMPLAINT OUTRANKS THE TOOL, and nothing else does.
  //
  // Mirrors the precedence rule scoreLead already applies for the same reason:
  // "a complaint is what the message is, whatever product words it happens to
  // contain". An angry customer whose message also tripped a knowledge lookup
  // is not a knowledge_lookup — filing them as one is how a complaint rate
  // reads as zero while complaints arrive, since the tool almost always fires
  // and would almost always win.
  //
  // The tool wins everywhere else because elsewhere it is the better evidence:
  // it says what the agent did, not what the keywords suggested.
  if (fromText === "complaint") return { intent: "complaint", source: "text" };

  for (const call of input.toolCalls ?? []) {
    const intent = TOOL_INTENT[call.name];
    if (intent) return { intent, source: "tool" };
  }

  if (fromText) return { intent: fromText, source: "text" };

  // No tool, and either no text (a media-only message) or nothing the rules
  // could read. Both are honestly `unknown`.
  return { intent: "unknown", source: "none" };
}
