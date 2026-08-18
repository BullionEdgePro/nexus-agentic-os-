/**
 * What one reply's retrieval is recorded as, when it searched more than once.
 *
 * The agent may call `search_knowledge` several times while composing a single
 * message, and `conversation_metrics` has one row per reply. Something has to
 * collapse several outcomes into one, and the shape of that collapse is a
 * judgement rather than a detail — it decides what an operator sees and, during
 * an outage, whether anybody sees anything.
 *
 * Pulled out of the processor as a pure function so it can be tested with actual
 * combinations. Inline, the only way to check the ordering was to read a nested
 * ternary and agree with it, and a wrong rung there is invisible: every value it
 * can return is a legitimate value, so a mistake produces a plausible record of
 * a reply that did not happen that way.
 */
export type RetrievalOutcome = "hit" | "miss" | "failed" | "degraded";

/**
 * The order a WhatsApp message moves through, and the only definition of it.
 *
 * Meta reports delivery asynchronously and DOES NOT PROMISE ORDER: `delivered`
 * and `read` arrive on separate webhook deliveries, either of which can be
 * retried, so a late `sent` overtaking an early `read` is ordinary rather than
 * exceptional. Applied blindly, that walks a message backwards and an operator
 * watching for stuck messages finds one that the customer has already read.
 *
 * Exported rather than written into the SQL because `recordDeliveryStatus`
 * passes this array to Postgres as a parameter and compares `array_position`
 * against it. There is therefore one ladder, not a TypeScript one and a SQL one
 * that agree until somebody edits either.
 *
 * `failed` is deliberately absent. It is not a rung — it is terminal, it can
 * arrive from any point, and nothing may move a message off it.
 */
export const DELIVERY_STATUS_LADDER = ["queued", "sent", "delivered", "read"] as const;

/**
 * Worst wins, and the order is the point.
 *
 *   failed   — at least one lookup could not run and found nothing. The reply is
 *              partly ungrounded whatever else came back, so this outranks
 *              everything.
 *   degraded — semantic search was unavailable and keyword search answered. Not
 *              a healthy retrieval: recording it as one would hide an outage
 *              inside its own mitigation, and `retrieval-unavailable` sweeps for
 *              exactly this value to avoid going blind (migration 047).
 *   hit      — something genuinely useful came back.
 *   miss     — it ran, and honestly found nothing. The floor rather than a
 *              failure: a refusal this platform designs for on purpose.
 *
 * Null when nothing searched at all, which is most replies. A default of 'miss'
 * would invent a retrieval that never ran — the mistake migration 038 exists to
 * end — so the absence stays an absence.
 */
export function worstRetrievalOutcome(
  outcomes: readonly (string | undefined)[]
): RetrievalOutcome | null {
  if (outcomes.length === 0) return null;
  if (outcomes.includes("failed")) return "failed";
  if (outcomes.includes("degraded")) return "degraded";
  if (outcomes.includes("hit")) return "hit";
  return "miss";
}
