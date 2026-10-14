import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Sealing a Business HQ vault password (spec 2026-10-14-business-hq-design.md §5.2).
 *
 * Same construction as token-crypto.ts — AES-256-GCM, stored as base64
 * `iv:tag:ciphertext` — but its OWN key, and with no fallback. The token key
 * falls back to a hash of the session secret so a deploy never takes WhatsApp
 * down for a missing variable; the vault must not. It holds the logins to every
 * website, host and social account of five businesses, so a leak of the session
 * secret or the token key must not open it, and a server without
 * NEXUS_VAULT_KEY refuses to seal or open rather than seal with something
 * guessable.
 *
 * The key is read on every call (not cached at import), so setting it on the
 * server takes effect on the next request and tests can switch it.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const MIN_KEY_LENGTH = 32;

function vaultKey(): Buffer {
  const raw = process.env.NEXUS_VAULT_KEY;
  if (!raw || raw.length < MIN_KEY_LENGTH) {
    throw new Error("VAULT_NOT_CONFIGURED: NEXUS_VAULT_KEY is not set on the server (32+ characters)");
  }
  return createHash("sha256").update(`business-hq-vault:${raw}`).digest();
}

/** True when the server has a usable vault key. */
export function vaultConfigured(): boolean {
  const raw = process.env.NEXUS_VAULT_KEY;
  return !!raw && raw.length >= MIN_KEY_LENGTH;
}

/** Seal a password for storage. Never log the input or the output. */
export function sealVaultSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, vaultKey(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

/**
 * Open a sealed password. Throws on a wrong key, a tampered value or a missing
 * key: unlike a social token, a password that cannot be opened is not a
 * "reconnect" case the screen can recover from quietly — the reveal must fail
 * loudly and say why.
 */
export function openVaultSecret(sealed: string): string {
  const parts = sealed.split(":");
  if (parts.length !== 3) throw new Error("VAULT_UNREADABLE: not a sealed vault value");
  const [iv, tag, body] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv(ALGORITHM, vaultKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
