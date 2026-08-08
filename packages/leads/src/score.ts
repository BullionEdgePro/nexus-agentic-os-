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
 * KNOWN LIMITATION: matching is English-only. The tenants are UAE-based and
 * real traffic will include Arabic, which scores 0 here and lands at 'normal'.
 * That is a deliberate floor rather than a silent failure — an unscored lead
 * still appears in the inbox — but it is the first thing to fix before this is
 * relied on for routing.
 */
const RULES: readonly Rule[] = [
  {
    name: "purchase_intent",
    weight: 30,
    category: "purchase_intent",
    phrases: [
      "how much", "price", "cost", "buy", "order", "purchase", "in stock",
      "available", "delivery", "ship to", "discount", "payment",
    ],
  },
  {
    name: "booking_intent",
    weight: 28,
    category: "booking_intent",
    phrases: [
      "appointment", "consultation", "book a", "schedule", "meeting",
      "viewing", "visit", "available slot", "discovery call",
    ],
  },
  {
    name: "legal_inquiry",
    weight: 25,
    category: "legal_inquiry",
    phrases: [
      "lawyer", "legal", "contract", "license", "licence", "court",
      "visa", "trademark", "company formation", "attorney",
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
    ],
  },
  {
    name: "high_value",
    weight: 20,
    category: "high_value",
    phrases: ["bulk", "wholesale", "quantity", "corporate", "how many can", "large order"],
  },
  {
    name: "urgency",
    weight: 18,
    phrases: ["urgent", "asap", "immediately", "today", "right now", "emergency"],
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
    "we are a", "we provide", "we offer", "our company", "manufacturer",
    "partnership", "collaborate", "seo", "web design", "lead generation",
    "data provider", "years of experience", "b2b", "supplier", "we specialize",
  ],
};

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
  const text = input.text.toLowerCase();
  const signals: LeadSignal[] = [];

  let score = 0;
  let bestCategory = "general_inquiry";
  let bestPrecedence = -1;
  let bestWeight = 0;

  for (const rule of RULES) {
    const matched = matchPhrases(text, rule.phrases);
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

  const pitchMatches = matchPhrases(text, PITCH_RULE.phrases);
  if (pitchMatches.length > 0) {
    signals.push({ name: PITCH_RULE.name, weight: PITCH_RULE.weight, matched: pitchMatches });
    score += PITCH_RULE.weight;
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
