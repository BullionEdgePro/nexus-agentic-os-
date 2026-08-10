/**
 * The redaction gate.
 *
 * `scanForPii` answers "does this message contain PII?" — good enough to flag an
 * outgoing reply for review, because a human then looks at it. This answers a
 * harder question: "may this text leave the tenant it came from?" Nothing may
 * cross that boundary until it has passed through here.
 *
 * Three things make this different from the scanner:
 *
 * 1. IT PRODUCES TEXT, not a list of findings. A caller that has to do its own
 *    replacement will eventually do it slightly differently somewhere.
 *
 * 2. IT FAILS CLOSED. After redacting, the result is scanned again, and if
 *    anything is still detectable the text is refused outright rather than
 *    returned partially cleaned. A redactor that silently half-works is worse
 *    than none: it produces text that looks safe and carries a phone number.
 *
 * 3. IT RESOLVES OVERLAPS. A 16-digit card number also matches the phone
 *    pattern, and an Emirates ID matches both. Redacting matches independently
 *    leaves fragments of the longer value behind — "784-1990-[PHONE]-1" is not a
 *    redaction, it is a partial one that still identifies a person.
 *
 * WHAT THIS CANNOT DO, which matters more than what it can:
 *
 * It cannot remove names, addresses, company details, or the substance of what
 * someone asked about. Those are not patterns; a regex cannot find them and a
 * model cannot be trusted to — a redactor that misses one in fifty is not 98%
 * safe, it is a leak with a good average. So free customer text must never be
 * pooled across tenants on the strength of this gate. Anything shared between
 * businesses should be structured facts (a category, a count, a duration),
 * never prose. See `SHAREABLE` below.
 */

import { scanForPii, type PiiMatch } from "./pii.js";

export type PiiKind = PiiMatch["type"] | "iban";

interface Span {
  start: number;
  end: number;
  kind: PiiKind;
}

const PATTERNS: Array<{ kind: PiiKind; re: RegExp; check?: (raw: string) => boolean }> = [
  // Ordered most-specific first. Overlap resolution below prefers the longest
  // match, but a stable order keeps ties predictable.
  { kind: "emirates_id", re: /\b784-?\d{4}-?\d{7}-?\d\b/g },
  { kind: "iban", re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g },
  { kind: "email", re: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi },
  { kind: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "credit_card", re: /\b(?:\d[ -]?){13,19}\b/g, check: (raw) => luhn(raw.replace(/\D/g, "")) },
  { kind: "phone", re: /(?:\+?\d[\d\-. ]{8,14}\d)/g },
];

const PLACEHOLDER: Record<PiiKind, string> = {
  email: "[EMAIL]",
  phone: "[PHONE]",
  credit_card: "[CARD]",
  ssn: "[GOV-ID]",
  emirates_id: "[EMIRATES-ID]",
  iban: "[IBAN]",
};

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Longest match wins, and overlapping shorter matches are dropped entirely.
 *
 * This is the part that is easy to get wrong. Replacing matches one pattern at a
 * time mutates the string underneath the other patterns' offsets, and replacing
 * by offset without resolving overlaps redacts the middle of a longer value and
 * leaves its ends in place.
 */
function collectSpans(text: string): Span[] {
  const found: Span[] = [];

  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (match.index === undefined) continue;
      if (pattern.check && !pattern.check(match[0])) continue;

      // The card and phone patterns allow a separator after each digit, so the
      // final repetition swallows the space that follows the value: "card 4539…
      // yesterday" matched through to the 'y' and redaction produced
      // "[CARD]yesterday". The value is still removed either way, but eating
      // the neighbouring text is how a redactor quietly destroys the sentence
      // it was supposed to preserve.
      const trimmed = match[0].replace(/[\s\-.]+$/, "");
      if (!trimmed) continue;

      found.push({ start: match.index, end: match.index + trimmed.length, kind: pattern.kind });
    }
  }

  found.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  const kept: Span[] = [];
  for (const span of found) {
    const overlaps = kept.some((existing) => span.start < existing.end && existing.start < span.end);
    if (!overlaps) kept.push(span);
  }
  return kept.sort((a, b) => a.start - b.start);
}

export interface RedactionResult {
  /** The redacted text. Empty when `safe` is false — a refusal returns nothing usable. */
  text: string;
  /** How many of each kind were removed, for audit without logging the values. */
  removed: Partial<Record<PiiKind, number>>;
  /** False when PII survived redaction. The caller must not use the text. */
  safe: boolean;
  /** Present only on refusal, and names the kinds that survived — never the values. */
  reason?: string;
}

export function redactPii(text: string): RedactionResult {
  const spans = collectSpans(text);

  let out = "";
  let cursor = 0;
  const removed: Partial<Record<PiiKind, number>> = {};

  for (const span of spans) {
    out += text.slice(cursor, span.start) + PLACEHOLDER[span.kind];
    removed[span.kind] = (removed[span.kind] ?? 0) + 1;
    cursor = span.end;
  }
  out += text.slice(cursor);

  // Verify rather than assume. The scanner is the same one used to flag replies
  // for human review, so passing it is the same bar the rest of the system uses.
  // Anything it still finds means the redaction did not work, and the honest
  // response is to hand back nothing.
  const survivors = scanForPii(out);
  if (survivors.length > 0) {
    const kinds = [...new Set(survivors.map((match) => match.type))].join(", ");
    return {
      text: "",
      removed,
      safe: false,
      reason: `Redaction incomplete — ${kinds} still detectable. Text withheld.`,
    };
  }

  return { text: out, removed, safe: true };
}

/**
 * The fields that may cross a tenant boundary.
 *
 * This list, not the redactor, is what makes cross-tenant learning safe. Every
 * entry is a structured fact about an interaction; none is anything a customer
 * or employee wrote. That is deliberate: redaction handles patterns, and the
 * things that most identify a person in a WhatsApp message — their name, their
 * company, what they were asking about — are not patterns.
 *
 * A field added here should be one you would be comfortable showing to a
 * competitor of the business it came from, because in a shared model that is
 * effectively what happens.
 */
export const SHAREABLE = [
  "intent_category",
  "was_escalated",
  "resolution_seconds",
  "message_count",
  "language",
  "lead_score_band",
] as const;

export type ShareableField = (typeof SHAREABLE)[number];

/**
 * Strips a record down to the shareable fields.
 *
 * An allow-list, never a deny-list. A deny-list silently passes every field
 * someone adds later, and the failure is invisible until a customer's name is
 * already in a shared store.
 */
export function toShareableRecord(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of SHAREABLE) {
    if (input[field] !== undefined) out[field] = input[field];
  }
  return out;
}
