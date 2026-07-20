export interface PiiMatch {
  type: "email" | "phone" | "credit_card" | "ssn" | "emirates_id";
  redacted: string; // first/last two characters only, never the raw value
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+?\d[\d\-. ]{8,14}\d)/g;
const CREDIT_CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMIRATES_ID_RE = /\b784-?\d{4}-?\d{7}-?\d\b/g;

function redact(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 4) return `${value.slice(0, 2)}***${digits.slice(-2)}`;
  return "***";
}

function luhnValid(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/**
 * Deterministic, regex-based PII scan. Deliberately conservative (Luhn-check
 * card numbers, fixed-format government IDs) to keep false positives low —
 * this runs on every outgoing AI message, so noisy matches would train
 * agents/reviewers to ignore it.
 */
export function scanForPii(text: string): PiiMatch[] {
  const matches: PiiMatch[] = [];

  for (const match of text.matchAll(EMAIL_RE)) {
    matches.push({ type: "email", redacted: redact(match[0]) });
  }
  for (const match of text.matchAll(EMIRATES_ID_RE)) {
    matches.push({ type: "emirates_id", redacted: redact(match[0]) });
  }
  for (const match of text.matchAll(SSN_RE)) {
    matches.push({ type: "ssn", redacted: redact(match[0]) });
  }
  for (const match of text.matchAll(CREDIT_CARD_RE)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      matches.push({ type: "credit_card", redacted: redact(match[0]) });
    }
  }
  for (const match of text.matchAll(PHONE_RE)) {
    const digits = match[0].replace(/\D/g, "");
    // Skip anything already counted as a credit card / Emirates ID digit run.
    if (digits.length >= 8 && digits.length <= 15) {
      matches.push({ type: "phone", redacted: redact(match[0]) });
    }
  }

  return matches;
}
