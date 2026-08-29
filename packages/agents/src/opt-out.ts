/**
 * Somebody asking to be left alone.
 *
 * ============================================================
 * A COLUMN NOTHING EVER WROTE
 * ============================================================
 *
 * `contacts.reengagement_opted_out` has existed since migration 035. Two places
 * read it — the re-engagement operator and the staff campaign audience — and
 * NOTHING has ever set it to true. Every customer on this platform has been
 * un-opt-out-able since the column was created, and the code reads correctly
 * enough that nobody would notice: the audience query filters on a flag that is
 * false for everybody.
 *
 * That was survivable while the only outbound campaigns were utility messages
 * about an order somebody had actually placed. It stops being survivable the
 * moment a MARKETING template exists, because a marketing message nobody can
 * stop is precisely what produces a spam report — and on this deployment the
 * quality rating a spam report damages belongs to ONE number shared by six
 * businesses. The cheapest possible version of this feature is also the one
 * that takes the whole platform's deliverability down with it.
 *
 * ============================================================
 * NARROW ON PURPOSE
 * ============================================================
 *
 * The tempting implementation is `text.includes("stop")`. That unsubscribes
 * the customer who writes "please stop the delivery, I want to change the
 * address" — someone actively transacting, silently removed from every future
 * message, with no way for them or anybody else to discover it.
 *
 * So a message counts as an opt-out only when the WHOLE message is one, after
 * punctuation and case are removed. A quick-reply button sends exactly its own
 * label, which is the case this is built for; the handful of phrases beyond it
 * are what people type unprompted when there is no button to press.
 *
 * The asymmetry is deliberate. Missing an opt-out costs one more message and an
 * annoyed customer who will say it again, more loudly. Inventing one costs a
 * customer who is never contacted again and never finds out why.
 */

/** The quick-reply label carried on every marketing template. */
export const OPT_OUT_BUTTON_LABEL = "Stop promotions";

const EXACT = new Set([
  "stop",
  "stop promotions",
  "stop promotion",
  "stop messages",
  "stop messaging me",
  "unsubscribe",
  "opt out",
  "optout",
  "remove me",
  "no more messages",
  "dont message me",
  "do not message me",
  "leave me alone",
  // Arabic, because this is a UAE deployment and "stop" is not what everybody
  // types. Kept to the two forms a person actually sends.
  "توقف",
  "إلغاء الاشتراك",
]);

/**
 * Is this whole message a request to stop being messaged?
 *
 * Punctuation and case are stripped; word order and extra words are not
 * tolerated. "STOP." and "Stop promotions" match. "Can you stop sending me
 * these" does not — and that is a real cost, paid on purpose, because the
 * alternative errs towards silently removing people who are still talking to
 * you.
 */
export function looksLikeAnOptOut(text: string): boolean {
  const normalised = (text ?? "")
    .toLowerCase()
    .replace(/[.,!?;:'"()\[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalised) return false;
  return EXACT.has(normalised);
}

/**
 * What we say back.
 *
 * Sent as a plain message rather than through the agent, because an opt-out
 * must be honoured when the model is unreachable — that is exactly when a
 * frustrated customer sends one. It confirms the specific thing that has
 * changed and the thing that has NOT: they can still write in, and they will
 * still get an answer. A confirmation that reads as "goodbye" makes people
 * think they have closed their account.
 */
export function optOutConfirmation(businessName: string): string {
  return (
    `Done — you will not receive any more promotional messages from ${businessName}. ` +
    `You can still message us here any time and we will reply.`
  );
}
