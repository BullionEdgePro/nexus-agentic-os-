import { Hono } from "hono";
import { appBaseUrl } from "../lib/public-urls.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  listConnections,
  saveConnection,
  removeConnection,
  connectionSecret,
  recordSync,
  connectionExpiry,
  refreshStoredAccessToken,
  clientEmailAddresses,
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
import {
  gmailConfigured,
  gmailScopes,
  gmailRedirectUri,
  gmailAuthorizeUrl,
  exchangeGoogleCode,
  refreshGoogleToken,
  fetchGmailProfile,
  fetchClientMail,
  sendGmail,
} from "../lib/gmail.js";
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
      {
        id: "gmail",
        name: "Gmail",
        configured: gmailConfigured(),
        offers:
          "Mail to and from the people in YOUR client book — nothing else in the mailbox is ever fetched — and sending a reply to one of them.",
        cannot:
          "It never lists your inbox. If a client has no email address on file there is nothing to search for, and none of your other mail is read.",
        needs: gmailConfigured()
          ? null
          : `Create a Google Cloud OAuth client, set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server, and add ${gmailRedirectUri()} as an authorised redirect URI. Use an INTERNAL consent screen on your own Workspace — that skips Google's verification entirely.`,
        scopes: gmailScopes(),
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
  const app = appBaseUrl();
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

// ============================================================
// Gmail
// ============================================================

/**
 * A usable Gmail access token, refreshed if it has expired.
 *
 * Google's access tokens last an hour, so refreshing is the ordinary path
 * rather than the exception, and it happens HERE — once, in front of every
 * Gmail call — instead of being remembered at each call site.
 *
 * The refresh writes back only the access token. A Google refresh response does
 * not include a new refresh token, and round-tripping through `saveConnection`
 * would write null over the working one, leaving a connection that dies an hour
 * later with nothing to renew it.
 */
async function gmailToken(
  owner: { organizationId: string; employeeId: string | null }
): Promise<{ accessToken: string; scopes: string[] } | { error: string; status: 404 | 401 }> {
  const stored = await withTenant(owner.organizationId, () =>
    connectionSecret(owner.organizationId, owner.employeeId, "gmail")
  );
  if (!stored) {
    return {
      error: "Gmail is not connected, or the stored sign-in can no longer be read. Connect it again.",
      status: 404,
    };
  }

  const fresh = await withTenant(owner.organizationId, () =>
    connectionExpiry(owner.organizationId, owner.employeeId, "gmail")
  );
  // A minute of slack: a token that expires while the request is in flight
  // fails in a way that looks like a revoked connection.
  const stillGood = fresh && fresh.getTime() - Date.now() > 60_000;
  if (stillGood) return { accessToken: stored.accessToken, scopes: stored.scopes };

  if (!stored.refreshToken) {
    return {
      error:
        "This Gmail sign-in has expired and carries nothing to renew it — that happens when consent was given without offline access. Connect it again.",
      status: 401,
    };
  }

  try {
    const renewed = await refreshGoogleToken(stored.refreshToken);
    await withTenant(owner.organizationId, () =>
      refreshStoredAccessToken(
        owner.organizationId,
        owner.employeeId,
        "gmail",
        renewed.accessToken,
        renewed.expiresAt
      )
    );
    return { accessToken: renewed.accessToken, scopes: stored.scopes };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await withTenant(owner.organizationId, () =>
      recordSync(owner.organizationId, owner.employeeId, "gmail", message.slice(0, 200))
    );
    return {
      error: message.startsWith("GMAIL_RECONNECT")
        ? "Google has signed this connection out — access was revoked or the password changed. Connect it again."
        : "Could not renew the Gmail sign-in just now. Try again shortly.",
      status: 401,
    };
  }
}

connectionsRoute.get("/gmail/start", async (c) => {
  const scope = scopeOf(c);
  const owner = ownerOf(scope);
  if (!owner) return c.json({ error: "Only a staff member can connect their own mailbox." }, 403);

  if (!gmailConfigured()) {
    return c.json(
      {
        error:
          "Gmail is not set up on this server yet. The owner needs to create a Google OAuth client before anybody can connect.",
      },
      503
    );
  }

  const state = signState({
    organizationId: owner.organizationId,
    employeeId: owner.employeeId,
    // Google does not use PKCE for a confidential client, so there is no
    // verifier to carry. The field stays in the payload rather than becoming
    // optional: one state shape for both providers is one thing to verify.
    verifier: "",
    provider: "gmail",
    issuedAt: Date.now(),
    nonce: randomBytes(12).toString("base64url"),
  });

  c.header(
    "set-cookie",
    `${STATE_COOKIE}=${encodeURIComponent(state)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`
  );
  return c.json({ url: gmailAuthorizeUrl(state) });
});

connectionsRoute.get("/gmail/callback", async (c) => {
  const app = appBaseUrl();
  const back = (message: string) =>
    c.redirect(`${app}/deck/my-clients?connected=${encodeURIComponent(message)}`, 302);

  const refused = c.req.query("error");
  if (refused) {
    return back(
      refused === "access_denied" ? "Gmail was not connected — you cancelled." : `Google said: ${refused}`
    );
  }

  const source = clientKey(c.req.raw.headers);
  if (await loginBlocked(source)) {
    return back("Too many attempts from here. Wait a few minutes and try again.");
  }

  const code = c.req.query("code");
  const returnedState = c.req.query("state");
  const cookie = c.req.header("cookie") ?? "";
  const stored = /(?:^|;\s*)nexus_oauth_state=([^;]+)/.exec(cookie)?.[1];

  if (!code || !returnedState || !stored || decodeURIComponent(stored) !== returnedState) {
    await recordLoginFailure(source, "gmail-callback");
    return back("That sign-in could not be verified. Please try connecting again.");
  }

  const state = readState(returnedState);
  if (!state) {
    await recordLoginFailure(source, "gmail-callback");
    return back("That sign-in link had expired. Please try again.");
  }
  await clearLoginFailures(source);

  c.header("set-cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);

  try {
    const token = await exchangeGoogleCode(code);
    const profile = await fetchGmailProfile(token.accessToken);

    // NO REFRESH TOKEN IS A BROKEN CONNECTION, and it is worth refusing rather
    // than storing. Google withholds one when consent has been given before
    // without being forced; the result works for an hour and then fails in a
    // way nobody connects to this moment.
    if (!token.refreshToken) {
      logger.warn({ employeeId: state.employeeId }, "Google returned no refresh token");
      return back(
        "Google did not return a renewable sign-in. Remove this app at myaccount.google.com/permissions and connect again."
      );
    }

    await withTenant(state.organizationId, () =>
      saveConnection({
        organizationId: state.organizationId,
        employeeId: state.employeeId,
        provider: "gmail",
        externalId: profile.emailAddress,
        displayName: profile.emailAddress,
        avatarUrl: null,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt,
        scopes: token.scopes,
      })
    );

    logger.info({ employeeId: state.employeeId }, "Gmail connected");
    return back(`Gmail connected as ${profile.emailAddress}.`);
  } catch (err) {
    logger.error({ err }, "Gmail connection failed");
    return back(
      `Gmail could not be connected: ${err instanceof Error ? err.message.slice(0, 140) : "unknown error"}`
    );
  }
});

/**
 * Mail involving this person's own clients.
 *
 * The address list comes from their client book and nothing else, and an empty
 * book fetches nothing — see `fetchClientMail`, where an empty query would
 * otherwise mean every message in the mailbox.
 */
connectionsRoute.get("/gmail/mail", async (c) => {
  const scope = scopeOf(c);
  const owner = ownerOf(scope);
  if (!owner) return c.json({ error: "Only a staff member has a connected mailbox here." }, 403);

  const token = await gmailToken(owner);
  if ("error" in token) return c.json({ error: token.error }, token.status);

  const addresses = await withTenant(owner.organizationId, () =>
    clientEmailAddresses(owner.organizationId, owner.employeeId as string)
  );

  if (addresses.length === 0) {
    return c.json({
      messages: [],
      addressesSearched: 0,
      // Said explicitly, because an empty list otherwise reads as "no mail" when
      // it means "nobody to search for".
      note: "None of your clients has an email address on file yet, so there is nothing to search for. Add one when you add a client.",
    });
  }

  try {
    const messages = await fetchClientMail(token.accessToken, addresses);
    await withTenant(owner.organizationId, () =>
      recordSync(owner.organizationId, owner.employeeId, "gmail", null)
    );
    return c.json({ messages, addressesSearched: addresses.length, note: null });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : "unknown error";
    await withTenant(owner.organizationId, () =>
      recordSync(owner.organizationId, owner.employeeId, "gmail", message)
    );
    logger.warn({ err, employeeId: owner.employeeId }, "Could not read Gmail");
    return c.json({ error: `Gmail could not be read: ${message}` }, 502);
  }
});

/**
 * Send an email to a client.
 *
 * The recipient must already be in this person's client book. An endpoint that
 * sends to any address supplied by the caller is an open relay wearing a CRM's
 * clothes — and it would send as that person, from their real mailbox.
 */
connectionsRoute.post("/gmail/send", async (c) => {
  const scope = scopeOf(c);
  const owner = ownerOf(scope);
  if (!owner) return c.json({ error: "Only a staff member can send from their own mailbox." }, 403);

  const body = await c.req.json().catch(() => ({}));
  const to = typeof body.to === "string" ? body.to.trim().toLowerCase() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim().slice(0, 200) : "";
  const text = typeof body.body === "string" ? body.body.slice(0, 20_000) : "";

  if (!to || !subject || !text) {
    return c.json({ error: "A recipient, a subject and a message are all needed." }, 400);
  }

  const addresses = await withTenant(owner.organizationId, () =>
    clientEmailAddresses(owner.organizationId, owner.employeeId as string)
  );
  if (!addresses.includes(to)) {
    return c.json(
      {
        error:
          "That address is not one of your clients. Add them to your client book first — this only sends to people already there.",
      },
      403
    );
  }

  const token = await gmailToken(owner);
  if ("error" in token) return c.json({ error: token.error }, token.status);

  try {
    const id = await sendGmail(token.accessToken, { to, subject, body: text });
    logger.info({ employeeId: owner.employeeId, id }, "Sent an email from a connected mailbox");
    return c.json({ id });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 200) : "unknown error";
    logger.warn({ err }, "Gmail send failed");
    return c.json({ error: `It did not send: ${message}` }, 502);
  }
});

connectionsRoute.delete("/gmail", async (c) => {
  const scope = scopeOf(c);
  const owner = ownerOf(scope);
  if (!owner) return c.json({ error: "Only a staff member can disconnect their own mailbox." }, 403);

  const removed = await withTenant(owner.organizationId, () =>
    removeConnection(owner.organizationId, owner.employeeId, "gmail")
  );
  return c.json({ ok: removed });
});
