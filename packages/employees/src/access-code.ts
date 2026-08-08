import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Employee sign-in credentials.
 *
 * Deliberately an access CODE the operator issues, not a password the employee
 * chooses. Passwords would drag in reset flows, strength rules and a recovery
 * channel — real work that protects an internal tool used by a handful of
 * people per business. A code the operator generates, hands over once and can
 * reissue at any time covers the same ground with no account-recovery surface
 * at all.
 *
 * The code is generated here and never accepted from a client. A caller-chosen
 * code would let someone set "1234" for a login that can read a tenant's entire
 * customer history.
 */

// Ambiguous glyphs removed: these codes get read aloud, written on paper and
// typed on phones, where 0/O and 1/I/l are a support ticket waiting to happen.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;

const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

export function generateAccessCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    // Modulo bias across a 31-letter alphabet from a 256-value byte is a
    // fraction of a bit over a 10-character code. Irrelevant against the
    // ~49 bits of entropy that remain, and not worth a rejection loop.
    code += ALPHABET[bytes[i] % ALPHABET.length];
  }
  // Grouped for reading aloud: XXXXX-XXXXX.
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/** Fold away the formatting people add or drop when typing a code back in. */
export function normalizeAccessCode(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

/**
 * Hash for storage. Scrypt, so a leaked database does not hand over working
 * logins — the codes are high-entropy, but the cost of getting this right is
 * one function.
 */
export function hashAccessCode(code: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(normalizeAccessCode(code), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Constant-time verification.
 *
 * Returns false for anything malformed rather than throwing: a stored hash from
 * an older format, a truncated column, a null — none of those should crash a
 * login route, and all of them mean "this code does not verify".
 */
export function verifyAccessCode(code: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length !== SALT_BYTES || expected.length !== SCRYPT_KEYLEN) return false;

    const actual = scryptSync(normalizeAccessCode(code), salt, SCRYPT_KEYLEN);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
