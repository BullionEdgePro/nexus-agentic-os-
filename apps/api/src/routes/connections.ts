import { Hono } from "hono";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  listConnections,
  saveConnection,
  removeConnection,
  connectionSecret,
  recordSync,
  withTenant,
} from "@nexus/db";
import {
  tiktokConfigured,
  tiktokScopes,
  tiktokRedirectUri,
  tiktokAuthorizeUrl,
  makeVerifier,
  exchangeTikTokCode,
  fetchTikTokProfile,
  fetchTikTokVideos,
} from "../lib/tiktok.js";
import type { SessionScope } from "../lib/session.js";
import { env } from "../config/env.js";
import { clientKey, loginBlocked, recordLoginFailure, clearLoginFailures } from "../lib/login-throttle.js";
import { logger } from "../lib/logger.js";

/**
 * Connecting a social account.
 *
 * ============================================================
 * WHAT IS HONESTLY ON OFFER
 * ============================================================
 *
 * TikTok has no direct-message API. This connection reads identity and
 * audience: who the account is, how many followers, and how the recent videos
 * did. It exists to answer one question the platform could not previously
 * answer — the referral link is in that bio, so is the bio reaching anybody?
 *
 * The screen says that in those words. A "Connections" page that implies an
 * inbox is arriving is the same defect as a menu of closed doors, at feature
 * scale.
 *
 * ============================================================
 * THE STATE COOKIE CARRIES THE PKCE VERIFIER
 * ============================================================
 *
 * TikTok requires PKCE, so the callback needs the verifier that started the
 * flow. Holding it in a module-level map works perfectly on one process and
 * fails intermittently behind two — the callback can land on a different
 * container than the redirect did.
 *
 * So it travels in a signed, short-lived, httpOnly cookie. Signed because the
 * cookie also carries WHO is connecting: unsigned, somebody could rewrite it
 * and attach a TikTok account to a colleague's record.
 */
export const connectionsRoute = new Hono();

const STATE_COOKIE = "nexus_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000;

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

/**
 * Whose connections these are.
 *
 * A staff member gets their own; the owner gets the business's. Null employeeId
 * is the business, matching the column and every other "mine versus the
 * business's" split on this platform.
 */
function ownerOf(scope: SessionScope): { organizationId: string; employeeId: string | null } | null {
  if (scope.role === "employee") {
    if (!scope.organizationId || !scope.employeeId) return null;
    return { organizationId: scope.organizationId, employeeId: scope.employeeId };
  }
  // An operator connecting acts for a business, which they must name.
  return null;
}

interface StatePayload {
  organizationId: string;
  employeeId: string | null;
  verifier: string;
  provider: string;
  issuedAt: number;
  nonce: string;
}

function signState(payload: StatePayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", env.sessionSecret).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function readState(raw: string | undefined): StatePayload | null {
  if (!raw) return null;
  const [body, mac] = raw.split(".");
  if (!body || !mac) return null;

  const expected = createHmac("sha256", env.sessionSecret).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  // Constant time, because this is an authentication tag and a length-leaking
  // comparison on one is a habit worth not having.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
    if (Date.now() - payload.issuedAt > STATE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

// ============================================================
// What is connected, and what could be
// ============================================================

connectionsRoute.get("/", async (c) => {
  const scope = scopeOf(c);
  const owner = ownerOf(scope);

  if (!owner) {
    return c.json({
      // The owner has no employee record, so there is no personal account to
      // connect. Said plainly rather than returning an empty list, which reads
      // as "you have connected nothing".
      error:
        "Connections belong to a staff member's own accounts. An owner has no personal account here — a staff member connects theirs from their own sign-in.",
    }, 403);
  }

  const connections = await withTenant(owner.organizationId, () =>
    listConnections(owner.organizationId, owner.employeeId)
  );

  return c.json({
    connections,
    providers: [
      {
        id: "tiktok",
        name: "TikTok",
        configured: tiktokConfigured(),
        // Stated on the API rather than in the component, so there is one place
        // this is true and it cannot drift into marketing.
        offers: "Your profile, follower count and recent video performance.",
        cannot: "TikTok provides no way for any app to read or send direct messages.",
        // The exact thing an owner must do, named. "Not configured" without
        // this is a dead end.
        needs: tiktokConfigured()
          ? null
          : `Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET on the server, and add ${tiktokRedirectUri()} as a redirect URI in the TikTok developer app.`,
        scopes: tiktokScopes(),
      },
    ],
  });
});

// ============================================================
// Starting the flow
// ============================================================

connectionsRoute.get("/tiktok/start", async (c) => {
  const scope = scopeOf(c);
  const owner = ownerOf(scope);
  if (!owner) return c.json({ error: "Only a staff member can connect their own account." }, 403);

  if (!tiktokConfigured()) {
    return c.json(
      {
        error:
          "TikTok is not set up on this server yet. The owner needs to add the app's key and secret before anybody can connect.",
      },
      503
    );
  }

  const verifier = makeVerifier();
  const state = signState({
    organizationId: owner.organizationId,
    employeeId: owner.employeeId,
    verifier,
    provider: "tiktok",
    issuedAt: Date.now(),
    nonce: randomBytes(12).toString("base64url"),
  });

  // httpOnly and SameSite=Lax: the callback is a top-level GET redirect back
  // from tiktok.com, which Lax permits and Strict would silently drop.
  c.header(
    "set-cookie",
    `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );

  return c.json({ url: tiktokAuthorizeUrl(state, verifier) });
});

// ============================================================
// Coming back
// ============================================================

connectionsRoute.get("/tiktok/callback", async (c) => {
  const app = process.env.PUBLIC_APP_URL || "https://nexusagenticos.com";
  const back = (message: string) =>
    c.redirect(`${app}/deck/my-clients?connected=${encodeURIComponent(message)}`, 302);

  // TikTok reports a refusal by redirecting here with an error, not by failing.
  const refused = c.req.query("error");
  if (refused) {
    logger.info({ refused }, "TikTok sign-in was refused or cancelled");
    return back(
      refused === "access_denied" ? "TikTok was not connected — you cancelled." : `TikTok said: ${refused}`
    );
  }

  // THROTTLED, because this route verifies a signature over caller-supplied
  // input. Forging the HMAC is not realistic, but an endpoint that does
  // cryptography on whatever arrives and writes a row on success is exactly the
  // shape the login limiter exists for — and the gate that found this was right
  // to refuse to let me decide otherwise by hand.
  const source = clientKey(c.req.raw.headers);
  if (await loginBlocked(source)) {
    return c.json(
      { error: "Too many attempts from here. Wait a few minutes and try connecting again." },
      429
    );
  }

  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const cookie = c.req.header("cookie") ?? "";
  const stored = /(?:^|;\s*)nexus_oauth_state=([^;]+)/.exec(cookie)?.[1];

  // The state must match BOTH what TikTok returned and what we signed. Checking
  // only the cookie would accept a code from a flow somebody else started.
  if (!code || !returnedState || !stored || decodeURIComponent(stored) !== returnedState) {
    await recordLoginFailure(source, "tiktok-callback");
    return back("That sign-in could not be verified. Please try connecting again.");
  }

  const state = readState(returnedState);
  if (!state) {
    await recordLoginFailure(source, "tiktok-callback");
    return back("That sign-in link had expired. Please try again.");
  }

  // A verified state clears the counter, so somebody who mistyped their way
  // into a couple of failures is not locked out of a flow that then worked.
  await clearLoginFailures(source);

  // Cleared whatever happens next — it is single use by construction.
  c.header("set-cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);

  try {
    const token = await exchangeTikTokCode(code, state.verifier);
    const profile = await fetchTikTokProfile(token.accessToken, token.scopes);

    await withTenant(state.organizationId, () =>
      saveConnection({
        organizationId: state.organizationId,
        employeeId: state.employeeId,
        provider: "tiktok",
        externalId: profile.openId || token.openId,
        displayName: profile.username ? `@${profile.username}` : profile.displayName,
        avatarUrl: profile.avatarUrl,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        scopes: token.scopes,
      })
    );

    logger.info(
      { employeeId: state.employeeId, scopes: token.scopes },
      "TikTok account connected"
    );
    return back(`TikTok connected${profile.username ? ` as @${profile.username}` : ""}.`);
  } catch (err) {
    // The person is mid-redirect, so the only place to say anything is the
    // screen they land on. The message is theirs to read, not a stack trace.
    logger.error({ err }, "TikTok connection failed");
    return back(
      `TikTok could not be connected: ${err instanceof Error ? err.message.slice(0, 140) : "unknown error"}`
    );
  }
});

// ============================================================
// What the account is doing
// ============================================================

connectionsRoute.get("/tiktok/insights", async (c) => {
  const scope = scopeOf(c);
  const owner = ownerOf(scope);
  if (!owner) return c.json({ error: "Only a staff member has a connected account here." }, 403);

  const secret = await withTenant(owner.organizationId, () =>
    connectionSecret(owner.organizationId, owner.employeeId, "tiktok")
  );
  if (!secret) {
    return c.json(
      { error: "TikTok is not connected, or the stored sign-in can no longer be read. Connect it again." },
      404
    );
  }

  try {
    const [profile, videos] = await Promise.all([
      fetchTikTokProfile(secret.accessToken, secret.scopes),
      fetchTikTokVideos(secret.accessToken, secret.scopes),
    ]);

    await withTenant(owner.organizationId, () =>
      recordSync(owner.organizationId, owner.employeeId, "tiktok", null)
    );

    return c.json({
      profile,
      videos,
      // Named so the screen can explain an empty list rather than implying the
      // person has posted nothing.
      canReadVideos: secret.scopes.includes("video.list"),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : "unknown error";
    await withTenant(owner.organizationId, () =>
      recordSync(owner.organizationId, owner.employeeId, "tiktok", message)
    );
    logger.warn({ err, employeeId: owner.employeeId }, "Could not read TikTok");

    return c.json(
      {
        error: /access_token|token|expired|invalid/i.test(message)
          ? "TikTok has signed this connection out. Connect it again."
          : `TikTok could not be read: ${message}`,
      },
      502
    );
  }
});

connectionsRoute.delete("/tiktok", async (c) => {
  const scope = scopeOf(c);
  const owner = ownerOf(scope);
  if (!owner) return c.json({ error: "Only a staff member can disconnect their own account." }, 403);

  const removed = await withTenant(owner.organizationId, () =>
    removeConnection(owner.organizationId, owner.employeeId, "tiktok")
  );
  return c.json({ ok: removed });
});
