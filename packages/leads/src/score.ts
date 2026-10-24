export type LeadPriority = "low" | "normal" | "high" | "urgent";

export interface LeadSignal {
  name: string;
  weight: number;
  matched: string[];
}

export interface LeadAssessment {
  score: number; // 0-100
  priority: LeadPriority;
  category: string;
  signals: LeadSignal[];
}

export interface ScoreInput {
  text: string;
  /** Prior inbound messages from this contact. Drives the returning-customer signal. */
  priorInboundCount?: number;
}

interface Rule {
  name: string;
  weight: number;
  /** Category claimed when this rule is the strongest positive signal. */
  category?: string;
  /**
   * Tie-break for category selection, highest wins; weight decides only when
   * precedence is equal.
   *
   * Deriving the category from weight alone was wrong in a way real traffic
   * exposes immediately: "my order arrived damaged and I want a refund" matches
   * `order` (purchase, 30) more heavily than `damaged`/`refund` (complaint, 26),
   * so an angry customer was filed as a sales lead. What a message *is* cannot
   * be decided by an arithmetic accident between keyword lists.
   */
  precedence?: number;
  phrases: string[];
}

/** Extra weight per additional matching phrase, and the cap on that bonus. */
const EVIDENCE_BONUS = 6;
const MAX_EVIDENCE_BONUS = 12;

/**
 * Rules, not a model — deliberately, and per the architecture plan.
 *
 * A learned scorer needs labelled outcomes ("this lead converted") and none
 * exist yet: the platform has been live for days and nobody has marked a single
 * conversation won or lost. Training on that would encode guesses as ground
 * truth. Rules are transparent, debuggable, and produce the labelled history a
 * model would later need.
 *
 * Bilingual: English and Arabic. The tenants are UAE-based, so an English-only
 * scorer would have silently floored every Arabic customer at 'low' — the worst
 * possible bias, since it would have buried exactly the local buyers these
 * businesses most want to reach. Phrases and input are compared after
 * orthographic normalisation (see normalizeForMatch).
 *
 * Any other language still scores 0 and floors at 'low'. That is a deliberate
 * floor rather than a failure — the lead still reaches the inbox unranked.
 */
const RULES: readonly Rule[] = [
  {
    name: "purchase_intent",
    weight: 30,
    category: "purchase_intent",
    phrases: [
      "how much", "price", "cost", "buy", "order", "purchase", "in stock",
      "available", "delivery", "ship to", "discount", "payment",
      // Arabic. "بكم" and "كم سعر" are the everyday ways of asking a price in
      // the Gulf; "متوفر" is the stock question customers actually send.
      "بكم", "كم سعر", "كم السعر", "السعر", "سعر", "اشتري", "اريد اشتري",
      "اطلب", "متوفر", "متوفره", "التوصيل", "توصيل", "شحن", "الدفع", "خصم",
    ],
  },
  {
    name: "booking_intent",
    weight: 28,
    category: "booking_intent",
    phrases: [
      "appointment", "consultation", "book a", "schedule", "meeting",
      "viewing", "visit", "available slot", "discovery call",
      "موعد", "حجز", "احجز", "استشاره", "مقابله", "زياره",
    ],
  },
  {
    name: "legal_inquiry",
    weight: 25,
    category: "legal_inquiry",
    phrases: [
      "lawyer", "legal", "contract", "license", "licence", "court",
      "visa", "trademark", "company formation", "attorney",
      "محامي", "قانوني", "عقد", "رخصه", "ترخيص", "تاشيره", "محكمه",
      "تاسيس شركه", "علامه تجاريه",
    ],
  },
  {
    name: "complaint",
    weight: 26,
    category: "complaint",
    // Outranks every commercial category: a complaint is what the message is,
    // whatever product words it happens to contain.
    precedence: 10,
    phrases: [
      "complaint", "refund", "broken", "damaged", "defective", "wrong item",
      "never arrived", "not working", "disappointed", "unacceptable",
      "شكوي", "شكوه", "استرجاع", "استرداد", "مكسور", "تالف", "خربان",
      "لم يصل", "ما وصل", "غلط", "خطا", "مش شغال", "لا يعمل", "زعلان",
    ],
  },
  {
    name: "high_value",
    weight: 20,
    category: "high_value",
    phrases: [
      "bulk", "wholesale", "quantity", "corporate", "how many can", "large order",
      "بالجمله", "جمله", "كميه", "كميات", "طلبيه كبيره",
    ],
  },
  {
    name: "urgency",
    weight: 18,
    phrases: [
      "urgent", "asap", "immediately", "today", "right now", "emergency",
      "عاجل", "ضروري", "بسرعه", "اليوم", "حالا", "الان", "مستعجل",
    ],
  },
];

/**
 * Inbound B2B pitches — the dominant traffic on this number in practice.
 *
 * Scoring these DOWN matters as much as scoring buyers up. Left unweighted they
 * trip "purchase_intent" on words like "products" and "order" and would crowd
 * genuine customers out of a priority-sorted inbox, which is precisely the
 * outcome this feature exists to prevent.
 */
const PITCH_RULE: Rule = {
  name: "inbound_pitch",
  weight: -35,
  category: "inbound_pitch",
  phrases: [
    // Self-description — the sender introducing their own business.
    "we are a", "we provide", "we offer", "our company", "manufacturer",
    // Not bare "partnership" (24 Oct 2026): a buyer's sign-off hoping for "a
    // long-term business partnership" hid a $5,000 bulk order as a pitch. A
    // seller OFFERS one; these are the phrasings that offer.
    "partnership opportunity", "partnership proposal", "offer a partnership",
    "offer you a partnership", "propose a partnership", "collaborate", "seo", "web design", "lead generation",
    "data provider", "years of experience", "b2b", "supplier", "we specialize",
    "we can provide", "we sell",

    // DIRECTION is the real discriminator, and the first version missed it.
    // "Do you want to purchase X" is someone selling TO us; "how much is X"
    // is someone buying FROM us. Both contain purchase vocabulary, so keyword
    // matching alone scored a spam blast as the hottest lead in the inbox.
    // Second-person offers are the sender pitching, not asking.
    "do you want to", "do you need any", "do you need a", "are you interested",
    "are you looking for", "would you like to buy", "contact us for", "dm for",

    // Promotional register. Genuine customers do not advertise at you.
    "special offer", "limited time", "best price", "low price", "premium data",
    "latest updates", "exclusive", "available for sale", "for sale",

    // Advertising inventory the SENDER holds. "available" alone is ambiguous —
    // it appears in "is this available?" (buyer) and "data available"
    // (seller) — so the pairing carries the signal, not the word.
    "data available", "leads available", "database", "investor data", "owner data",

    // The store-growth cold pitch, which became most of a business mailbox once
    // every email from a person reached the inbox (30 Sep 2026). Each phrase is
    // the SENDER describing our shop back to us or what they will do to it --
    // never something a buyer asks. "your store" alone is not here: "is your
    // store open?" is a customer. Pinned by a-store-growth-pitch-is-a-pitch.
    "checked your store", "visited your store", "love the brand", "what you've built",
    "what you’ve built", "caught my attention", "more sales", "extra sales",
    "additional sales", "organic traffic", "organic growth", "conversion",
    "free sample for you", "ai videos", "no upfront", "keine vorauszahlung",
    "shop owner", "store owner", "checkout configuration", "technical consultant",
    "black friday",

    // The next wave, verbatim from the business mailbox (24 Oct 2026), each of
    // which Staff work listed as a customer waiting for weeks. Again only the
    // sender talking about what THEY will do for our shop; the customer
    // phrasings that share words ("share a photo", "confirm my email address",
    // "came across your product") are pinned as customers in the same test.
    "ur shp", "would you work with me", "generate consistent orders",
    "collaboration idea", "email address is active", "active and monitored",
    "potential opportunity", "revenue for your store", "customer acquisition",
    "customer-acquisition", "your shopify store", "ugc",
    "mutual business growth", "potential buyers", "abandoned carts",
    "no recovery email", "still don't buy", "still don’t buy", "chat button on the store",

    // Arabic equivalents. "نحن شركة" (we are a company) and "نقدم خدمات" (we
    // offer services) are the standard openings of an Arabic cold pitch, and
    // "هل تحتاج" / "هل ترغب" (do you need / would you like) carry the same
    // second-person selling direction as their English counterparts.
    "نحن شركه", "نقدم خدمات", "نقدم لكم", "شركتنا", "هل تحتاج", "هل ترغب",
    "عرض خاص", "افضل سعر", "تواصل معنا", "خدماتنا", "لدينا قاعده بيانات",
  ],
};

/**
 * Decorative "font" letters: Unicode Mathematical Alphanumeric Symbols, the
 * bold and italic a cold-email tool pastes in to stand out (24 Oct 2026). A
 * customer typing on a phone or keyboard does not produce them. Structural,
 * like the caps and header checks, so it outlives this week's vocabulary.
 */
function hasStyledLetters(original: string): boolean {
  return /[\u{1D400}-\u{1D7FF}]/u.test(original);
}

/**
 * WhatsApp bold (*like this*) wrapping the opening line.
 *
 * A marketing convention: broadcast tools bold the headline, real customers
 * asking a question do not. Structural like the caps check, so it does not
 * depend on this week's spam vocabulary.
 */
function hasBroadcastHeader(original: string): boolean {
  const firstLine = original.trim().split("\n")[0] ?? "";
  return /^\*.+\*$/.test(firstLine.trim()) && firstLine.length > 15;
}

/**
 * Broadcast blasts SHOUT.
 *
 * Promotional spam is disproportionately upper-case ("PREMIUM DATA — MAY 2026
 * UPDATE"), while real customers type normally. A cheap structural signal that
 * needs no keyword list and generalises past whatever vocabulary this week's
 * spam happens to use.
 *
 * Ignores short strings, where a single shouted word ("OK", "HELP") proves
 * nothing.
 */
function looksLikeBroadcast(original: string): boolean {
  const letters = original.replace(/[^a-z]/gi, "");
  if (letters.length < 20) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.4;
}

// normalizeForMatch moved to @nexus/shared so the switchboard, lead scoring
// and the onboarding collision audit all fold text identically. Re-exported
// here because callers already import it from this module.
import { normalizeForMatch } from "@nexus/shared";
export { normalizeForMatch };


/**
 * Phrase lists normalised once and cached per rule.
 *
 * Scoring runs on every inbound message, so re-normalising ~150 static phrases
 * each time would be pure waste. The rules are module constants, so the cache
 * can never go stale.
 */
const PHRASE_CACHE = new WeakMap<Rule, string[]>();
function normalizedPhrases(rule: Rule): string[] {
  let cached = PHRASE_CACHE.get(rule);
  if (!cached) {
    cached = rule.phrases.map(normalizeForMatch);
    PHRASE_CACHE.set(rule, cached);
  }
  return cached;
}

function matchPhrases(haystack: string, phrases: string[]): string[] {
  return phrases.filter((phrase) => haystack.includes(phrase));
}

/**
 * Score one inbound message for commercial intent.
 *
 * Pure and synchronous: no model call, no I/O, no latency added to the reply
 * path, and the whole policy is unit-testable without infrastructure.
 */
export function scoreLead(input: ScoreInput): LeadAssessment {
  // Both sides compared in the same normal form — see normalizeForMatch.
  // NFKC first (24 Oct 2026): decorative "bold italic" letters are separate
  // Unicode code points, so no phrase could match them until they are folded
  // back to plain letters. Kept here rather than in the shared normaliser,
  // which also drives routing.
  const text = normalizeForMatch(input.text.normalize("NFKC"));
  const signals: LeadSignal[] = [];

  let score = 0;
  let bestCategory = "general_inquiry";
  let bestPrecedence = -1;
  let bestWeight = 0;

  for (const rule of RULES) {
    const matched = matchPhrases(text, normalizedPhrases(rule));
    if (matched.length === 0) continue;

    // More matching phrases is stronger evidence: "how much" AND "in stock"
    // is a clearer buying signal than "price" alone, and should outrank it.
    // Capped so a keyword-stuffed message cannot dominate on repetition.
    const bonus = Math.min((matched.length - 1) * EVIDENCE_BONUS, MAX_EVIDENCE_BONUS);
    const weight = rule.weight + bonus;

    signals.push({ name: rule.name, weight, matched });
    score += weight;

    const precedence = rule.precedence ?? 0;
    const wins =
      precedence > bestPrecedence || (precedence === bestPrecedence && weight > bestWeight);
    if (rule.category && wins) {
      bestPrecedence = precedence;
      bestWeight = weight;
      bestCategory = rule.category;
    }
  }

  const pitchMatches = matchPhrases(text, normalizedPhrases(PITCH_RULE));
  if (looksLikeBroadcast(input.text)) pitchMatches.push("shouted/broadcast formatting");
  if (hasBroadcastHeader(input.text)) pitchMatches.push("bolded broadcast header");
  if (hasStyledLetters(input.text)) pitchMatches.push("decorative unicode letters");

  if (pitchMatches.length > 0) {
    // Negative weight grows with evidence too: several pitch markers together
    // must be able to overwhelm the buying vocabulary a pitch borrows.
    const bonus = Math.min((pitchMatches.length - 1) * EVIDENCE_BONUS, MAX_EVIDENCE_BONUS);
    const weight = PITCH_RULE.weight - bonus;
    signals.push({ name: PITCH_RULE.name, weight, matched: pitchMatches });
    score += weight;
    // A pitch is what this message IS, regardless of which buying words it
    // happens to contain, so it overrides the category outright.
    bestCategory = "inbound_pitch";
  }

  // A contact who has written before is engaged; a first-time message is not
  // yet a relationship. Small weight — returning spam is still spam.
  const priorCount = input.priorInboundCount ?? 0;
  if (priorCount > 0 && pitchMatches.length === 0) {
    const weight = Math.min(12, 4 + priorCount * 2);
    signals.push({ name: "returning_contact", weight, matched: [`${priorCount} prior messages`] });
    score += weight;
  }

  const clamped = Math.max(0, Math.min(100, score));
  return { score: clamped, priority: toPriority(clamped, bestCategory), category: bestCategory, signals };
}

/**
 * A complaint is escalated regardless of score.
 *
 * An unhappy customer generates few "high value" keywords and would otherwise
 * sink to the bottom of a revenue-sorted inbox — which is exactly backwards:
 * the cost of a slow reply is highest there.
 */
function toPriority(score: number, category: string): LeadPriority {
  if (category === "complaint") return "urgent";
  if (category === "inbound_pitch") return "low";
  if (score >= 55) return "urgent";
  if (score >= 35) return "high";
  if (score >= 15) return "normal";
  return "low";
}
