/**
 * A WhatsApp send refusal, in a sentence a staff member can act on.
 *
 * broadcast_recipients.delivery_error holds Meta's raw error body. The five
 * codes below are the ones a staff campaign actually meets; each is matched as
 * the `"code":N` field Meta returns, never as digits anywhere in the text — a
 * phone number or trace id can contain the same digits. Anything unrecognised
 * is shown as it came, because a paraphrase of an error nobody has seen yet
 * would be a guess.
 */
const EXPLAINED: Record<number, string> = {
  131026: "This person is not on WhatsApp.",
  131047: "More than 24 hours since they last wrote — only an approved message can reach them.",
  131049: "WhatsApp held this marketing message back to protect the person's inbox. Try again in a few days.",
  132001: "That message is not approved on this number.",
  131056: "Too many messages to this person in a short time.",
};

/** A campaign recipient with no WhatsApp number — an email-only customer. */
export const NO_WHATSAPP_NUMBER = "This customer has no WhatsApp number (email only).";

export function explainSendError(raw: string): string {
  // Meta's generic code 100 says only "invalid parameter"; this one is the empty
  // recipient the 22 Oct campaign met fourteen times, so it is matched by text.
  if (/The parameter to is required/i.test(raw)) return NO_WHATSAPP_NUMBER;
  const code = /"code"\s*:\s*(\d+)/.exec(raw);
  if (code) {
    const explained = EXPLAINED[Number(code[1])];
    if (explained) return explained;
  }
  return raw.trim().slice(0, 200);
}
