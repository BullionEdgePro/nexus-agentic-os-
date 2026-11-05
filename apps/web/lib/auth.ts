// Minimal, dependency-free session auth for the command deck.
// HMAC-SHA256 signed token via Web Crypto — works in both Node route handlers
// and the Edge middleware runtime. This gates a single operator account; it is
// intentionally simple (internal console), not a multi-user identity system.

const enc = new TextEncoder();

export const SESSION_COOKIE = "nexus_session";
const TTL_MS = 1000 * 60 * 60 * 12; // 12h
/**
 * "Keep me signed in" (5 Nov 2026): 30 days on that device, renewed while it is
 * used (middleware.ts). The switch had been on the form for weeks and was never
 * sent, so every sign-in ended after 12 hours whatever it said. Removing a person
 * still signs them out at once — the API refuses a removed person's session.
 */
const KEPT_MS = 1000 * 60 * 60 * 24 * 30;
/** How old a kept sign-in may get before a visit renews it. */
const RENEW_AFTER_MS = 1000 * 60 * 60 * 24;

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

/**
 * What a session says about its bearer.
 *
 * The scope is signed INTO the token rather than looked up per request, so an
 * employee cannot widen it without forging an HMAC. A scope re-derived from a
 * client-supplied id is only ever as trustworthy as that id.
 */
export interface SessionClaims {
  role: "operator" | "employee";
  /** Set when the operator session came from a named admin account. */
  adminId?: string;
  employeeId?: string;
  organizationId?: string;
  organizationSlug?: string;
}

/** A verified session: who, with what scope, and how long it has left. */
export type Session = { sub: string } & SessionClaims & {
  /** Signed in with "Keep me signed in": lasts 30 days and is renewed on use. */
  kept: boolean;
  /** When it was signed; absent on sessions made before 5 Nov 2026. */
  issuedAt?: number;
  expiresAt: number;
};

export async function signSession(
  email: string,
  claims: SessionClaims = { role: "operator" },
  options: { remember?: boolean; now?: number } = {}
): Promise<string> {
  const now = options.now ?? Date.now();
  const kept = options.remember === true;
  // The claims first, so nothing in them can stand in for the times.
  const body = b64url(
    textBytes(
      JSON.stringify({ sub: email, ...claims, iat: now, exp: now + (kept ? KEPT_MS : TTL_MS), ...(kept ? { kept: true } : {}) })
    )
  );
  const key = await hmacKey(sessionSecret());
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, textBytes(body)));
  return body + "." + b64url(sig);
}

export async function verifySession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  try {
    const key = await hmacKey(sessionSecret());
    const ok = await crypto.subtle.verify("HMAC", key, fromB64url(sig), textBytes(body));
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as {
      sub: string;
      exp: number;
      iat?: number;
      kept?: boolean;
    } & Partial<SessionClaims>;
    if (!payload.exp || Date.now() > payload.exp) return null;
    const life = {
      kept: payload.kept === true,
      issuedAt: typeof payload.iat === "number" ? payload.iat : undefined,
      expiresAt: payload.exp,
    };

    // An employee claim is honoured only when complete. A token saying
    // "employee" without naming a business would otherwise read as an operator
    // — failing open on a malformed token is how a scoping bug becomes a leak.
    if (payload.role === "employee") {
      if (!payload.employeeId || !payload.organizationId || !payload.organizationSlug) return null;
      return {
        sub: payload.sub,
        role: "employee",
        employeeId: payload.employeeId,
        organizationId: payload.organizationId,
        organizationSlug: payload.organizationSlug,
        ...life,
      };
    }

    // Tokens issued before scoping existed carry no role, and were only ever
    // given to the operator password.
    return { sub: payload.sub, role: "operator", adminId: payload.adminId, ...life };
  } catch {
    return null;
  }
}

/**
 * Whether this visit should renew the sign-in: a kept one more than a day old.
 * A session made before 5 Nov 2026 carries no "kept" and simply runs out.
 */
export function needsRenewal(session: Session, now: number = Date.now()): boolean {
  return session.kept && session.issuedAt !== undefined && now - session.issuedAt > RENEW_AFTER_MS;
}

/** The scope a session was signed with, to sign it again unchanged. */
export function claimsOf(session: Session): SessionClaims {
  return session.role === "employee"
    ? {
        role: "employee",
        employeeId: session.employeeId,
        organizationId: session.organizationId,
        organizationSlug: session.organizationSlug,
      }
    : { role: "operator", ...(session.adminId ? { adminId: session.adminId } : {}) };
}

/**
 * How the session cookie is written — at sign-in and at every renewal, so the
 * two can never set it under different scopes (a second cookie of the same name
 * is what once made sign-out silently fail; see api/auth/logout).
 *
 * A kept sign-in's cookie lasts as long as its token. One not kept has no
 * Max-Age, so it ends when the browser closes, and its token after 12 hours.
 */
export function sessionCookieOptions(kept: boolean) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    domain: sessionCookieDomain(),
    ...(kept ? { maxAge: KEPT_MS / 1000 } : {}),
  };
}

/**
 * Cookie Domain attribute.
 *
 * The browser talks to the API on a sibling host (app.example.com →
 * api.example.com). A host-only cookie is never sent there, so the API could
 * not authenticate browser traffic at all. Setting the parent domain makes the
 * session travel to both, and because they share a registrable domain the
 * request is same-site — a SameSite=Lax cookie still applies.
 *
 * Unset in local development, where everything is on localhost already.
 */
export function sessionCookieDomain(): string | undefined {
  return process.env.SESSION_COOKIE_DOMAIN || undefined;
}
