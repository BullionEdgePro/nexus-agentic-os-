/**
 * The moments this platform speaks in its OWN words, named once.
 *
 * WHY THIS VOCABULARY IS TINY, AND WHY IT MUST STAY THAT WAY.
 *
 * Almost everything a customer reads is composed by the model from retrieved
 * knowledge. There are exactly two moments where it is not — where the platform
 * sets the model aside and sends a sentence somebody wrote — and both already
 * exist in production as string constants in the reply processor:
 *
 *   handing_over      the agent is stepping back and a colleague will follow up
 *   no_one_available  the same moment with nobody to hand to, so the agent
 *                     stays live and asks for more instead of promising a
 *                     specialist who does not exist
 *
 * Those two constants are sent by three call sites — governance escalation, the
 * AI-failure path, and the handover flag — and they are IDENTICAL for a
 * retailer and two law firms. "I'm looping in a specialist from our team" is a
 * reasonable thing for Zipicka to say and a strange thing for ABR Advocates to
 * say, and changing either has always required a deploy.
 *
 * So this list is not a design for a phrasebook. It is the set of moments the
 * platform ALREADY has authored wording for, given a home per business.
 *
 * THE RULE FOR ADDING ONE: a moment goes in this list only when the reply path
 * can already detect it and already speaks at it. A moment nothing detects is
 * wording that never fires — invisible, plausible-looking, and precisely the
 * failure this codebase keeps finding. If a new moment needs new detection,
 * that detection is the work, and this constant is the last line written rather
 * than the first.
 *
 * Deliberately NOT here: the triage menu. It is sent before the switchboard
 * knows which business the customer wants, so there is no business whose
 * wording it could use. It belongs to the platform, and `buildTriageMessage`
 * is where it stays.
 */
export const PHRASE_MOMENTS = ["handing_over", "no_one_available"] as const;

export type PhraseMoment = (typeof PHRASE_MOMENTS)[number];

export function isPhraseMoment(value: string): value is PhraseMoment {
  return (PHRASE_MOMENTS as readonly string[]).includes(value);
}

/** What a person is choosing between, in their words rather than the column's. */
export const PHRASE_MOMENT_LABELS: Record<PhraseMoment, string> = {
  handing_over: "When a colleague is taking over",
  no_one_available: "When nobody is available to take over",
};

export const PHRASE_MOMENT_BLURBS: Record<PhraseMoment, string> = {
  handing_over:
    "Sent when the agent steps back — either governance held the reply, or the model could not " +
    "answer. Somebody is on shift, so this promises a person and pauses the agent.",
  no_one_available:
    "The same moment with an empty rota. This one must NOT promise anyone: the agent keeps " +
    "answering, because a customer told help is coming and then cut off from the only thing " +
    "replying to them is the worst state this platform can produce.",
};

/**
 * Long enough to be courteous, short enough to stay a single WhatsApp message.
 *
 * Not a formatting preference. This text is sent VERBATIM — it is not a hint
 * the model can trim — so an over-long phrase is delivered over-long, and a
 * one-word one is delivered as a one-word reply to a customer who is already
 * being told nobody can help them right now.
 */
export const MIN_PHRASE_CHARS = 20;
export const MAX_PHRASE_CHARS = 600;

/**
 * Placeholders nobody has filled in.
 *
 * THE REASON THIS EXISTS, and it is the single most important guard in the
 * feature. Catalogue wording ships with `{{open_time}}` in it, because the
 * catalogue cannot know when a business opens. Everywhere else on this platform
 * a stored string is CONTEXT the model reads and can work around. Here it is
 * the message. An unfilled placeholder is not a degraded reply — it is
 * `we read messages from {{open_time}}` arriving on a customer's phone.
 *
 * So it is caught at the only point that matters: a phrase carrying one cannot
 * be switched on. Not a warning, not a lint — the activation is refused, and
 * the sentence says which placeholder to fill.
 */
export function unfilledPlaceholders(body: string): string[] {
  const found = body.match(/\{\{\s*[^}]+\s*\}\}/g) ?? [];
  return [...new Set(found.map((match) => match.trim()))];
}

export type PhraseCheck = { ok: true; body: string } | { ok: false; error: string };

/**
 * Validate a phrase on the way in.
 *
 * Forgiving about whitespace, strict about everything a customer would see.
 * Written to be read by a person, because the caller is a form.
 */
export function checkPhraseBody(input: unknown): PhraseCheck {
  if (typeof input !== "string") return { ok: false, error: "A phrase is a line of text." };
  const body = input.trim().replace(/\s+\n/g, "\n");

  if (body.length < MIN_PHRASE_CHARS) {
    return {
      ok: false,
      error: `That is too short to send to a customer — at least ${MIN_PHRASE_CHARS} characters.`,
    };
  }
  if (body.length > MAX_PHRASE_CHARS) {
    return {
      ok: false,
      error: `That is ${body.length} characters; keep it under ${MAX_PHRASE_CHARS} so it stays one message.`,
    };
  }
  return { ok: true, body };
}
