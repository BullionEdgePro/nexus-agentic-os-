// Verification half of the operator session issued by apps/web/lib/auth.ts.
//
// The API previously accepted every request on /api/* with no authentication
// at all. CORS was the only thing in front of it, and CORS is a browser
// convention — it does nothing against curl, so an anonymous request could
// read every tenant's WhatsApp conversations, including customer phone numbers
// and message bodies.
//
// This mirrors the web app's signing logic exactly (same HMAC-SHA256 over the
// same base64url body, same NEXUS_SESSION_SECRET) rather than introducing a
// second token format, so one login works for the UI and the API both.

const enc = new TextEncoder();

export const SESSION_COOKIE = "nexus_session";

function textBytes(value: string): Uint8Array<ArrayBuffer> {
  const src = enc.encode(value);
  const out = new Uint8Array(new ArrayBuffer(src.length));
  out.set(src);
  return out;
}

function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  let s = value.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = Buffer.from(s, "base64").toString("binary");
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Return type is inferred rather than annotated: `CryptoKey` is a DOM lib type
// and this package compiles against Node's libs only.
async function hmacKey(secret: string) {
  return crypto.subtle.importKey("raw", textBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string
): Promise<{ sub: string } | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [body, signature] = parts;
  try {
    const key = await hmacKey(secret);
    const valid = await crypto.subtle.verify("HMAC", key, fromB64url(signature), textBytes(body));
    if (!valid) return null;

    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as {
      sub?: string;
      exp?: number;
    };
    if (!payload.sub || !payload.exp || Date.now() > payload.exp) return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
}

/** Read one cookie out of a raw Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}
