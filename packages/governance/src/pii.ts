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
export interface ScanOptions {
  /**
   * The business's OWN published material — the retrieved knowledge-base
   * passages the reply was grounded in. Anything that looks like PII and also
   * appears verbatim here is the business quoting itself, not leaking somebody.
   *
   * Deliberately NOT the conversation history. That can carry a third party's
   * details a customer typed in, and repeating those back out is exactly the
   * leak this scan exists to catch.
   */
  publishedContext?: string;
}

export function scanForPii(text: string, options: ScanOptions = {}): PiiMatch[] {
  // The raw value is carried only inside this function. `PiiMatch` exposes the
  // redacted form alone, and these matches are written into evaluation notes
  // that get stored and displayed — so the unredacted string must not escape.
  const found: Array<PiiMatch & { raw: string }> = [];
  const add = (type: PiiMatch["type"], raw: string) =>
    found.push({ type, redacted: redact(raw), raw });

  for (const match of text.matchAll(EMAIL_RE)) add("email", match[0]);
  for (const match of text.matchAll(EMIRATES_ID_RE)) add("emirates_id", match[0]);
  for (const match of text.matchAll(SSN_RE)) add("ssn", match[0]);
  for (const match of text.matchAll(CREDIT_CARD_RE)) {
    const digits = match[0].replace(/\D/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhnValid(digits)) {
      add("credit_card", match[0]);
    }
  }
  for (const match of text.matchAll(PHONE_RE)) {
    const digits = match[0].replace(/\D/g, "");
    // Skip anything already counted as a credit card / Emirates ID digit run.
    if (digits.length >= 8 && digits.length <= 15) add("phone", match[0]);
  }

  const published = options.publishedContext ?? "";
  return found
    .filter((match) => !published.includes(match.raw))
    .map(({ raw: _raw, ...match }) => match);
}
