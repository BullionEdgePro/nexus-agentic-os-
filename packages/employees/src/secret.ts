import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Hash and verify a secret, exactly as given.
 *
 * Split out from `access-code.ts` because the two have opposite requirements.
 * An access code is read aloud and typed back, so it is normalised — upper
 * cased, dashes and spaces stripped — before hashing. A password is chosen by a
 * person and **case matters**: normalising it would silently make `Correct` and
 * `CORRECT` the same secret, shrinking the keyspace and quietly weakening every
 * account that used a capital letter.
 *
 * So this pair does no normalisation at all, and `access-code.ts` normalises
 * first and then calls in here. One scrypt implementation, two policies.
 */

const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;

export function hashSecret(plain: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/**
 * Constant-time verification.
 *
 * Returns false for anything malformed rather than throwing: an older hash
 * format, a truncated column or a null should never crash a sign-in route, and
 * all of them mean "this does not verify".
 */
export function verifySecret(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;

  try {
    const salt = Buffer.from(parts[1], "hex");
    const expected = Buffer.from(parts[2], "hex");
    if (salt.length !== SALT_BYTES || expected.length !== SCRYPT_KEYLEN) return false;

    const actual = scryptSync(plain, salt, SCRYPT_KEYLEN);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/**
 * A password strong enough that nobody has to invent one.
 *
 * Generated server-side and shown once, the same pattern as employee access
 * codes and the database role. A password the operator types in is a password
 * that travels through a chat log, an email, or my transcript.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";

export function generatePassword(length = 20): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}
