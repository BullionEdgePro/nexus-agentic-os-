/**
 * The intent vocabulary — one list, shared by every producer.
 *
 * WHY THIS IS A SHARED CONSTANT AND NOT A STRING PER CALL SITE.
 *
 * F5 pools patterns keyed on `(intent_category, language)`. Two producers
 * naming the same thing differently — a tool handler writing
 * `appointment_booking` while a text classifier writes `booking_intent` — do
 * not produce one pattern with a disagreement in it. They produce TWO patterns,
 * each holding half the samples, each looking thinner than the truth, and
 * neither ever reaching the 20-sample threshold that would make it usable.
 *
 * That failure is invisible: both rows look like perfectly reasonable patterns.
 * The store would simply never fill, and nothing would say why. The existing
 * comment in `shared-brain.ts` makes this exact argument about the `language`
 * column ("a wrong label here would split one pattern into two that each look
 * thinner than the truth") — this file is that argument applied to the other
 * half of the key.
 *
 * So: every intent written to `conversation_metrics.intent` comes from here.
 */
export const INTENT_CATEGORIES = [
  /** Wants a time: an appointment, a viewing, a consultation. */
  "appointment_booking",
  /** Asking whether a thing is in stock. */
  "inventory_inquiry",
  /** Asked something the knowledge base answered. */
  "knowledge_lookup",
  /** Price, delivery, bulk — someone trying to buy. */
  "purchase_inquiry",
  /** Lawyer, contract, licence, visa, court. */
  "legal_inquiry",
  /** Something went wrong and they are unhappy about it. */
  "complaint",
  /** Someone selling TO us. Not a customer enquiry at all — see below. */
  "inbound_pitch",
  /** The classifier ran and declined to place this message. See below. */
  "unknown",
] as const;

export type IntentCategory = (typeof INTENT_CATEGORIES)[number];

/**
 * Intents that are real, correct classifications but must never become shared
 * patterns.
 *
 * `inbound_pitch` is the load-bearing one. Lead scoring's own comment records
 * that inbound B2B pitches are "the dominant traffic on this number in
 * practice" — so pooling them would make the platform's single largest and
 * first-to-qualify pattern a statistic about spam. "Inbound pitches escalate 0%
 * of the time" is true, useless, and would be the flagship output of a feature
 * called the Neural Brain.
 *
 * `unknown` is excluded for a different and more important reason: it is not a
 * category, it is the absence of one. Pooling it would create a large,
 * confident-looking pattern whose only real content is "we could not tell".
 *
 * Excluded from the ROLLUP, deliberately not from the WRITE. Both are still
 * stored on every metric row, because their share of traffic is the measure of
 * how much of the platform F5 can actually see — and a number you cannot query
 * is a number nobody will notice is bad.
 */
export const NON_PATTERN_INTENTS: readonly IntentCategory[] = ["unknown", "inbound_pitch"];

export function isPatternIntent(intent: string | null | undefined): boolean {
  if (!intent) return false;
  return !NON_PATTERN_INTENTS.includes(intent as IntentCategory);
}

/**
 * NULL AND `unknown` ARE DIFFERENT, AND THE DIFFERENCE IS THE POINT.
 *
 * Before this vocabulary existed, `conversation_metrics.intent` was null on 83%
 * of rows in production, and null meant two things at once:
 *
 *   - no tool fired, so nothing was ever derived  (expected, most traffic)
 *   - the classifier failed or was never called   (a defect)
 *
 * One value covering both means the defect can never be seen: a classifier that
 * silently stopped running produces exactly the same table as a quiet week.
 * That is the recurring shape of every serious bug on this system — a plausible
 * normal state, no error, nothing to grep for.
 *
 * After this change the two are separate and each is checkable:
 *
 *   - `unknown` — the classifier ran and declined to guess. Expected. Its share
 *     is coverage, and coverage is reported by `getBrainStatus`.
 *   - `null`    — the classifier did not run at all. A DEFECT. Nothing in the
 *     reply path should write null any more, so a rising null count is a real
 *     signal rather than background noise.
 */
export const INTENT_NULL_MEANS_CLASSIFIER_DID_NOT_RUN = true;
