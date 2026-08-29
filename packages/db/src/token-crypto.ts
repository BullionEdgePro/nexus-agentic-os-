import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypting a credential before it touches the database.
 *
 * ============================================================
 * WHAT IS ACTUALLY BEING PROTECTED
 * ============================================================
 *
 * An OAuth access token is a bearer credential for somebody's real TikTok,
 * Instagram or mail account. Stored in plain text, a routine database dump on
 * somebody's laptop becomes a set of live logins to five people's personal
 * accounts — and unlike a password nobody can tell it has happened.
 *
 * So the key lives OUTSIDE the database, in the environment, and the two have
 * to be stolen together. That is the whole property. It does not defend against
 * an attacker already running as this process, and it is not meant to: it
 * defends against the backup, the replica, the screenshot of a query result.
 *
 * ============================================================
 * AES-256-GCM, NOT CBC
 * ============================================================
 *
 * GCM authenticates as well as encrypts, so a ciphertext altered in the
 * database fails to decrypt rather than decrypting to something else. With CBC
 * a flipped bit is a silently different token, which fails later, somewhere
 * else, as an authentication error against the platform.
 *
 * The stored form is `iv:tag:ciphertext`, base64 each, joined by colons — one
 * self-describing string that survives a dump and restore without anybody
 * having to think about column encodings.
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/**
 * The key, derived once.
 *
 * `NEXUS_TOKEN_KEY` is the intended source. It falls back to hashing the
 * session secret rather than refusing to start, for a deliberate reason: this
 * platform already runs, and a deploy that will not boot because a new variable
 * is missing takes WhatsApp down to protect a TikTok token nobody has connected
 * yet. The fallback is derived, never the secret itself, so the two cannot be
 * confused and a leak of one is not a leak of the other.
 *
 * It is worth setting the real variable — rotating the session secret would
 * otherwise make every stored token undecryptable, which is a nasty way to
 * discover a coupling.
 */
function key(): Buffer {
  const explicit = process.env.NEXUS_TOKEN_KEY;
  if (explicit && explicit.length >= 32) return createHash("sha256").update(explicit).digest();

  const session = process.env.NEXUS_SESSION_SECRET;
  if (!session) {
    throw new Error(
      "No NEXUS_TOKEN_KEY and no NEXUS_SESSION_SECRET — refusing to store a credential unencrypted."
    );
  }
  // Domain-separated, so this value is not the session key even though it is
  // derived from the same secret.
  return createHash("sha256").update(`social-token:${session}`).digest();
}

/** Encrypt a token for storage. Never log the input or the output. */
export function sealToken(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), body.toString("base64")].join(":");
}

/**
 * Read one back.
 *
 * Returns null rather than throwing on anything malformed — a row encrypted
 * under a rotated key, a truncated column, a value written before this existed.
 * The caller's correct response to all of those is the same: treat the
 * connection as needing to be reconnected, and say so. An exception here would
 * instead take out whatever screen happened to be listing connections.
 */
export function openToken(sealed: string | null | undefined): string | null {
  if (!sealed) return null;
  const parts = sealed.split(":");
  if (parts.length !== 3) return null;

  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, "base64"));
    const decipher = createDecipheriv(ALGORITHM, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
