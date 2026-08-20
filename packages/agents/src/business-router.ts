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

/**
 * The tag a deep link puts in front of the customer's message.
 *
 * Every business is reachable on one number, which solved connectivity and
 * created an adoption problem: a customer who wants the law firm still lands in
 * a triage menu, because nothing in "hi" says which business they came for. So
 * each business gets a wa.me link whose prefilled text carries its slug, and a
 * message opening with that tag routes with no menu and no guessing.
 *
 * Checked BEFORE keywords, and deliberately so. Keyword classification is
 * probabilistic — it can land on ambiguous, which is the right answer for free
 * text and the wrong one for a link the business itself published. Someone who
 * followed ABR's link should reach ABR even if their first message happens to
 * mention a keyword the retail store also claims.
 *
 * Matched only at the START of a message. A tag appearing later is far more
 * likely to be a customer quoting something than an intent to switch business,
 * and honouring it mid-conversation would let one business's routing be changed
 * by text a customer pasted from somewhere else.
 */
const DEEP_LINK_TAG = /^\s*#([a-z0-9][a-z0-9-]{1,40})/i;

export function findDeepLinkTag(text: string, businesses: RoutableBusiness[]): RoutableBusiness | null {
  const match = DEEP_LINK_TAG.exec(text ?? "");
  if (!match) return null;
  const slug = match[1].toLowerCase();
  return businesses.find((business) => business.slug.toLowerCase() === slug) ?? null;
}

/**
 * The link a business publishes so its customers skip triage.
 *
 * `phoneNumber` is the shared number in international form without a plus,
 * which is what wa.me expects. The tag leads the prefilled text so the router
 * sees it first; the rest is written for the customer to read and send as-is.
 */
export function buildDeepLink(business: RoutableBusiness, phoneNumber: string): string {
  const digits = phoneNumber.replace(/\D/g, "");
  const text = `#${business.slug} Hello ${business.name}, I would like to ask about`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

export function classifyBusiness(
  text: string,
  businesses: RoutableBusiness[]
): RoutingOutcome {
  // A published link is an explicit statement of which business the customer
  // came for. Nothing downstream should second-guess it.
  const tagged = findDeepLinkTag(text, businesses);
  if (tagged) return { kind: "routed", business: tagged, matched: [`#${tagged.slug}`] };

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
/** Does this string contain Arabic script? */
const isArabic = (value: string) => /\p{Script=Arabic}/u.test(value);

/**
 * How many of a business's own terms to show beside its name.
 *
 * Three. One is not a description, and five turns a menu into a wall on a phone
 * screen — the whole point is that it can be read at a glance and answered with
 * a digit.
 */
const HINT_TERMS = 3;

/**
 * A few words telling a stranger what this business actually does.
 *
 * THE MENU LISTED NAMES AND NOTHING ELSE, and on this platform that asked
 * customers an impossible question. Three of the five are law firms, and two of
 * them are called "Juris Prime" and "Juris Prime Legal". Somebody who wants a
 * degree certificate attested has no way to tell which of those to pick, and a
 * person with a rent dispute has three plausible answers. Getting it wrong
 * routes them to a firm that cannot help and makes their first impression of
 * all five a wasted exchange.
 *
 * TAKEN FROM THEIR OWN ROUTING KEYWORDS, not written here. These are the terms
 * each business configured as "this enquiry is mine", so showing them tells the
 * customer what that firm says it handles. Inventing descriptions for five real
 * companies would be putting words in their mouths on their own number.
 *
 * FILTERED BY SCRIPT, because the keyword lists are bilingual and interleaved:
 * ABR's begin "legal, التحكيم, محامون, defence". Taking the first three
 * verbatim would hand an English speaker two words they cannot read. So the
 * hint is drawn from the terms in the script the customer wrote in, which is
 * the same signal the surrounding message already uses.
 *
 * Returns empty when nothing matches, and the line falls back to the bare name.
 * A business with no keywords in the customer's script is better shown plainly
 * than annotated with characters they cannot read.
 */
function hintFor(business: RoutableBusiness, wantArabic: boolean): string {
  const seen = new Set<string>();
  const terms: string[] = [];

  for (const raw of business.routingKeywords) {
    const keyword = raw.trim();
    if (!keyword || isArabic(keyword) !== wantArabic) continue;

    // Deduplicated on a NORMALISED form and displayed as written.
    //
    // SFS lists both "ايجار" and "إيجار" — the same word, spelled with and
    // without the hamza, because both are typed and both must route. That is
    // correct for matching and reads as a stutter in a menu: two of the three
    // things the customer is told about this firm would be one thing twice.
    //
    // Alef forms are folded for the comparison only. The term shown is the
    // business's own spelling, not a normalised one.
    const normalised = keyword.toLowerCase().replace(/[\u0623\u0625\u0622]/g, "\u0627");
    if (seen.has(normalised)) continue;
    seen.add(normalised);

    terms.push(keyword);
    if (terms.length === HINT_TERMS) break;
  }

  if (terms.length === 0) return "";

  // The Arabic comma, in the Arabic menu. The rest of that message is written
  // with Arabic punctuation and a Latin comma in the middle of it is the kind
  // of detail a reader notices without being able to say why.
  return ` — ${terms.join(wantArabic ? "\u060C " : ", ")}`;
}

export function buildTriageMessage(businesses: RoutableBusiness[], customerText = ""): string {
  const wantArabic = isArabic(customerText);
  const options = businesses
    .map((b, i) => `${i + 1}. ${b.name}${hintFor(b, wantArabic)}`)
    .join("\n");

  // Answered in the script the customer wrote in.
  //
  // This is the first message anyone receives whose enquiry could not be routed,
  // and it was English-only on a platform whose customers are in Dubai. Lead
  // scoring had already been fixed for Arabic; the one reply every unrouted
  // Arabic speaker sees had not, which is the wrong way round — someone who
  // cannot read the menu cannot choose from it, and simply leaves.
  //
  // Any Arabic at all selects the Arabic reply, rather than a majority count.
  // The asymmetry is deliberate: a customer who typed Arabic can certainly read
  // it, while an Arabic speaker handed an English menu may be unable to answer
  // at all. Guessing wrong in that direction costs the enquiry.
  //
  // Business names are left as written — they are brand names rather than text
  // to translate, and "ABR Advocates" is what appears on their door.
  if (wantArabic) {
    return (
      "مرحباً! لقد وصلت إلى مجموعة شركاتنا. " +
      "لتوجيهك إلى الفريق المناسب، ما هو موضوع استفسارك؟\n\n" +
      options +
      "\n\nيرجى الرد برقم الخيار أو باسم الشركة."
    );
  }

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
