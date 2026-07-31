// Minimal, dependency-free session auth for the command deck.
// HMAC-SHA256 signed token via Web Crypto — works in both Node route handlers
// and the Edge middleware runtime. This gates a single operator account; it is
// intentionally simple (internal console), not a multi-user identity system.

const enc = new TextEncoder();

export const SESSION_COOKIE = "nexus_session";
const TTL_MS = 1000 * 60 * 60 * 12; // 12h

// Always allocate over a concrete ArrayBuffer so the result types as
// Uint8Array<ArrayBuffer> — Web Crypto's BufferSource params reject the
// SharedArrayBuffer-compatible generic under TS 5.7+.
function textBytes(s: string): Uint8Array<ArrayBuffer> {
  const src = enc.encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", textBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export function sessionSecret(): string {
  return process.env.NEXUS_SESSION_SECRET || "nexus-dev-secret-change-me";
}

export function operatorPassword(): string {
  return process.env.NEXUS_OPERATOR_PASSWORD || "demo1234";
}

export async function signSession(email: string): Promise<string> {
  const body = b64url(textBytes(JSON.stringify({ sub: email, exp: Date.now() + TTL_MS })));
  const key = await hmacKey(sessionSecret());
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, textBytes(body)));
  return body + "." + b64url(sig);
}

export async function verifySession(token: string | undefined): Promise<{ sub: string } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const key = await hmacKey(sessionSecret());
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sig), textBytes(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as { sub: string; exp: number };
    if (!payload.exp || Date.now() > payload.exp) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

export const SESSION_MAX_AGE = TTL_MS / 1000;
