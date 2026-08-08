import { normalizeForMatch } from "@nexus/leads";

export interface RoutableBusiness {
  id: string;
  slug: string;
  name: string;
  routingKeywords: string[];
}

export type RoutingOutcome =
  | { kind: "routed"; business: RoutableBusiness; matched: string[] }
  | { kind: "ambiguous"; candidates: RoutableBusiness[] }
  | { kind: "unknown" };

/**
 * Decide which business an inbound message is for, on a number shared by several.
 *
 * Pure and keyword-driven, for the same reason lead scoring is: it costs
 * nothing, adds no latency to the reply path, and a misroute is visible in the
 * data instead of buried inside a model's judgement. A classifier can replace
 * this later using the routing history it generates.
 *
 * Three outcomes rather than a forced guess. Silently picking a business when
 * the message is ambiguous is the dangerous option here — routing decides which
 * GOVERNANCE applies, so a wrong guess can put a legal question in front of an
 * agent that is allowed to answer speculatively. "Ask the customer" is always
 * safe; guessing is not.
 */
/**
 * Reduce text to space-delimited words for whole-word matching.
 *
 * Substring matching is wrong here and was caught misrouting: "video
 * PRODUCTion" contains "product", a retail keyword, so a production enquiry
 * matched the e-commerce store. Since routing selects which governance policy
 * applies, a false match is not a cosmetic ranking error — it can put a legal
 * question in front of an agent permitted to answer speculatively.
 *
 * Strips punctuation to spaces rather than using `\b`, which is ASCII-only in
 * JavaScript and would silently fail for Arabic. Plurals and inflections are
 * listed explicitly in the keyword data instead of being inferred, which keeps
 * the rules predictable and debuggable.
 */
function toWordBag(text: string): string {
  return ` ${normalizeForMatch(text).replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

export function classifyBusiness(
  text: string,
  businesses: RoutableBusiness[]
): RoutingOutcome {
  const haystack = toWordBag(text);
  if (!haystack.trim()) return { kind: "unknown" };

  const hits = businesses
    .map((business) => ({
      business,
      matched: business.routingKeywords.filter((keyword) => {
        const needle = toWordBag(keyword).trim();
        return needle.length > 0 && haystack.includes(` ${needle} `);
      }),
    }))
    .filter((hit) => hit.matched.length > 0);

  if (hits.length === 0) return { kind: "unknown" };
  if (hits.length === 1) {
    return { kind: "routed", business: hits[0].business, matched: hits[0].matched };
  }

  // Several businesses matched. Strength of evidence breaks the tie, but only
  // when it is decisive — "contract" hits both the law firm and licensing, and
  // a one-keyword margin is not enough to gamble a governance decision on.
  hits.sort((a, b) => b.matched.length - a.matched.length);
  if (hits[0].matched.length >= hits[1].matched.length + 2) {
    return { kind: "routed", business: hits[0].business, matched: hits[0].matched };
  }

  return { kind: "ambiguous", candidates: hits.map((hit) => hit.business) };
}

/**
 * The triage message sent when routing cannot be decided.
 *
 * Deliberately makes no claim about anything — no prices, no legal or licensing
 * statements — because it is the one reply composed before a tenant's
 * governance policy is known. Asking a question is the only substantive thing
 * that is safe to say at this point.
 */
export function buildTriageMessage(businesses: RoutableBusiness[]): string {
  const options = businesses.map((b, i) => `${i + 1}. ${b.name}`).join("\n");
  return (
    "Hello! You've reached our group of businesses. " +
    "So I can put you with the right team, which of these is your enquiry about?\n\n" +
    options +
    "\n\nJust reply with the number or the name."
  );
}

/**
 * Resolve a reply to the triage menu — "2", "juris prime", "the legal one".
 *
 * Handled separately from keyword classification because the answer to "which
 * business?" is usually a bare ordinal, which carries no routing keywords at
 * all and would otherwise fall straight back to `unknown` and loop the menu
 * forever.
 */
export function resolveTriageReply(
  text: string,
  businesses: RoutableBusiness[]
): RoutableBusiness | null {
  const answer = normalizeForMatch(text).trim();
  if (!answer) return null;

  // A bare number, or a number leading the reply ("2 please").
  const ordinal = /^(\d{1,2})\b/.exec(answer);
  if (ordinal) {
    const index = Number(ordinal[1]) - 1;
    if (index >= 0 && index < businesses.length) return businesses[index];
  }

  // Name match, longest first so "juris prime legal" is not captured by the
  // shorter "juris prime" that is a prefix of it.
  const byLength = [...businesses].sort((a, b) => b.name.length - a.name.length);
  for (const business of byLength) {
    if (answer.includes(normalizeForMatch(business.name))) return business;
  }

  return null;
}
