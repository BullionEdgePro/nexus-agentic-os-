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

/**
 * Who a request is acting as.
 *
 * `operator` is the account that owns every business and sees all of them.
 * `employee` belongs to exactly one, named by `organizationSlug`, and the
 * middleware refuses any request for a different tenant.
 *
 * The scope is carried IN the signed token rather than looked up per request.
 * That is not a performance choice — it means an employee cannot widen their
 * own scope without forging an HMAC, whereas a scope re-derived from a
 * client-supplied id is only as trustworthy as the id.
 */
export interface SessionScope {
  sub: string;
  role: "operator" | "employee";
  employeeId?: string;
  organizationId?: string;
  organizationSlug?: string;
  /**
   * Which named admin account this operator session belongs to.
   *
   * The web app has signed this into the token since admin accounts landed;
   * this decoder simply dropped it, so every operator looked anonymous to the
   * API. /api/me could not tell whose profile to read, which is part of why it
   * reported that operators have none.
   *
   * Absent on sessions minted by the retired shared password — those had no
   * account behind them at all.
   */
  adminId?: string;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string
): Promise<SessionScope | null> {
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
      role?: string;
      employeeId?: string;
      organizationId?: string;
      organizationSlug?: string;
      adminId?: string;
    };
    if (!payload.sub || !payload.exp || Date.now() > payload.exp) return null;

    // An employee claim is only honoured when it is complete. A token that says
    // "employee" without naming a tenant would otherwise fall through to the
    // operator branch and be granted everything — failing open on a malformed
    // token is how a scoping bug becomes a data breach.
    if (payload.role === "employee") {
      if (!payload.employeeId || !payload.organizationId || !payload.organizationSlug) return null;
      return {
        sub: payload.sub,
        role: "employee",
        employeeId: payload.employeeId,
        organizationId: payload.organizationId,
        organizationSlug: payload.organizationSlug,
      };
    }

    // Tokens issued before this change carry no role. They were only ever
    // issued to the operator password, so treating them as operator preserves
    // existing sessions without widening anyone's access.
    return { sub: payload.sub, role: "operator", adminId: payload.adminId };
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
