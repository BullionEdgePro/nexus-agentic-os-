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
    "partnership", "collaborate", "seo", "web design", "lead generation",
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

    // Arabic equivalents. "نحن شركة" (we are a company) and "نقدم خدمات" (we
    // offer services) are the standard openings of an Arabic cold pitch, and
    // "هل تحتاج" / "هل ترغب" (do you need / would you like) carry the same
    // second-person selling direction as their English counterparts.
    "نحن شركه", "نقدم خدمات", "نقدم لكم", "شركتنا", "هل تحتاج", "هل ترغب",
    "عرض خاص", "افضل سعر", "تواصل معنا", "خدماتنا", "لدينا قاعده بيانات",
  ],
};

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

/**
 * Normalise text so Arabic matches survive real-world spelling variation.
 *
 * Arabic is written with optional diacritics and several interchangeable
 * letterforms, so the same word arrives spelled differently every time:
 * أريد / اريد, متوفرة / متوفره, كَم / كم. Matching raw strings would catch one
 * spelling and miss the rest — which reads as "Arabic support" while failing on
 * most real messages.
 *
 * Applied to both the input and the phrase lists so the two are compared in the
 * same normal form. Harmless for English.
 */
export function normalizeForMatch(value: string): string {
  return (
    value
      .toLowerCase()
      // Tashkeel (harakat) and the superscript alef — decorative, not semantic.
      .replace(/[ً-ْٰ]/g, "")
      // Tatweel: a kashida stretching character with no meaning.
      .replace(/ـ/g, "")
      // Alef with any hamza/madda → bare alef.
      .replace(/[آأإٱ]/g, "ا")
      // Alef maqsura → yaa; these are freely interchanged in practice.
      .replace(/ى/g, "ي")
      // Taa marbuta → haa; likewise (متوفرة vs متوفره).
      .replace(/ة/g, "ه")
      // Hamza carriers → their base letters.
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      // Arabic-Indic digits → ASCII, so numbers compare consistently.
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
  );
}

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
  const text = normalizeForMatch(input.text);
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
