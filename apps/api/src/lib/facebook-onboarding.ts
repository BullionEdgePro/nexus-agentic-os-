import { env } from "../config/env.js";
import { apiBaseUrl } from "./public-urls.js";

/**
 * Connecting a Facebook Page (and its linked Instagram) so the inbox can answer.
 *
 * ============================================================
 * THE ONE ROW THAT LIGHTS UP EVERYTHING ELSE
 * ============================================================
 *
 * Slices 1–4 built the whole Messenger/Instagram path — parse, identity, inbound
 * ingest, outbound send — and left it DORMANT because two resolvers had nothing
 * to read: organizationForConnectedPage (which business owns an inbound Page) and
 * pageConnectionForOutbound (the Page id + token to reply as). This flow writes
 * exactly the rows those two read, so connecting a Page is the single act that
 * turns the dormant channels live.
 *
 * It is a server-side OAuth code flow, the same shape as the TikTok and Gmail
 * connects: `/facebook/start` sends the person to Facebook, `/facebook/callback`
 * exchanges the code, reads their Pages, and stores each Page (and any Instagram
 * business account linked to it) as a `social_connections` row with the PAGE
 * access token — the credential every send uses.
 *
 * ============================================================
 * GATED ON META APP REVIEW, AND HONEST ABOUT IT
 * ============================================================
 *
 * The messaging scopes below (`pages_messaging`, `instagram_manage_messages`)
 * are only granted to a non-developer once Meta approves the app for them. Until
 * then this flow works for the app's own admins/testers — which is exactly what
 * records the demo Meta's review requires — and no further. Nothing here claims
 * a channel is live; the Channels screen keeps saying "awaiting approval" until
 * the review clears and a Page is actually connected.
 *
 * It reuses META_APP_ID / META_APP_SECRET — the same app the shared WhatsApp
 * number already runs on — so there is one Meta app, not a second to maintain.
 */

const DIALOG = "https://www.facebook.com";

/**
 * What the connect asks Facebook for.
 *
 *   pages_show_list          — list the Pages this person manages, to pick one.
 *   pages_manage_metadata    — subscribe the Page to our webhook.
 *   pages_messaging          — receive and send Messenger messages as the Page.
 *   business_management      — resolve Pages owned through a Business.
 *   pages_read_engagement    — read the Page's linked Instagram business account.
 *   instagram_basic          — see the Instagram account linked to the Page.
 *   instagram_manage_messages— receive and send Instagram DMs for that account.
 *
 * SPLIT PER CHANNEL, on purpose. Facebook (Messenger) and Instagram are two
 * separate connects in the inbox, so each asks for only what it needs: connecting
 * the Page must not make a person grant Instagram access they did not ask for, and
 * vice versa. Both still ride Facebook Login (an Instagram professional account is
 * reached through the Page it is linked to), so the Instagram set carries the page
 * permissions needed to find that link, subscribe the webhook, and hold the page
 * token every Instagram send uses.
 *
 * Each set is env-overridable (FACEBOOK_SCOPES / INSTAGRAM_SCOPES) like the TikTok
 * integration, because an installation that has cleared only some permissions in
 * review should ask for only those — an authorize URL asking for an ungranted
 * scope fails the whole sign-in.
 */
const FACEBOOK_PAGE_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_messaging",
  "business_management",
] as const;

const INSTAGRAM_SCOPES = [
  "pages_show_list",
  "pages_manage_metadata",
  "pages_read_engagement",
  "business_management",
  "instagram_basic",
  "instagram_manage_messages",
] as const;

function scopesFrom(envValue: string | undefined, fallback: readonly string[]): string[] {
  const configured = envValue?.trim();
  if (!configured) return [...fallback];
  const scopes = configured.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : [...fallback];
}

/** What the Facebook Page (Messenger) connect asks for. */
export function facebookScopes(): string[] {
  return scopesFrom(process.env.FACEBOOK_SCOPES, FACEBOOK_PAGE_SCOPES);
}

/** What the Instagram connect asks for — the IG permissions plus the page access it rides on. */
export function instagramScopes(): string[] {
  return scopesFrom(process.env.INSTAGRAM_SCOPES, INSTAGRAM_SCOPES);
}

/** Off until the shared Meta app's id and secret are both present. */
export function facebookConfigured(): boolean {
  return Boolean(env.metaAppId && process.env.META_APP_SECRET);
}

/** Where Facebook sends the person back. Must match a Valid OAuth Redirect URI exactly. */
export function facebookRedirectUri(): string {
  return process.env.FACEBOOK_REDIRECT_URI || `${apiBaseUrl()}/api/connections/facebook/callback`;
}

export function facebookAuthorizeUrl(state: string, scopes: string[]): string {
  const url = new URL(`/${env.metaGraphApiVersion}/dialog/oauth`, DIALOG);
  url.searchParams.set("client_id", env.metaAppId);
  url.searchParams.set("redirect_uri", facebookRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scopes.join(","));
  return url.toString();
}

const GRAPH = "https://graph.facebook.com";

async function graphGet(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const url = new URL(`/${env.metaGraphApiVersion}/${path}`, GRAPH);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = await fetch(url.toString());
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new Error(String(error.message ?? error.type ?? `HTTP ${response.status}`));
  }
  return payload;
}

/**
 * Exchange the login code for a LONG-LIVED user token.
 *
 * Two hops, both required. The code buys a short-lived token; that token is then
 * swapped for a long-lived one, which is what the page tokens derived from it
 * inherit. A page access token minted from a long-lived user token does not
 * expire, which is what a channel that must keep answering needs.
 */
export async function exchangeFacebookCode(code: string): Promise<string> {
  const short = await graphGet("oauth/access_token", {
    client_id: env.metaAppId,
    client_secret: process.env.META_APP_SECRET ?? "",
    redirect_uri: facebookRedirectUri(),
    code,
  });
  const shortToken = typeof short.access_token === "string" ? short.access_token : "";
  if (!shortToken) throw new Error("Facebook did not return an access token.");

  const long = await graphGet("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: env.metaAppId,
    client_secret: process.env.META_APP_SECRET ?? "",
    fb_exchange_token: shortToken,
  });
  const longToken = typeof long.access_token === "string" ? long.access_token : "";
  return longToken || shortToken;
}

/** A Page this person manages, and the Instagram business account linked to it. */
export interface ConnectablePage {
  pageId: string;
  name: string;
  /** The Page access token — the credential every Messenger/IG send uses. */
  pageAccessToken: string;
  instagram: { id: string; username: string | null } | null;
}

/**
 * The Pages this user manages, each with its own send credential and linked IG.
 *
 * A page access token comes back per Page here — that is the token to store and
 * send with, never the user token. The Instagram business account is resolved in
 * the same call so a linked IG is connected in one step.
 */
export async function fetchFacebookPages(userAccessToken: string): Promise<ConnectablePage[]> {
  const payload = await graphGet("me/accounts", {
    access_token: userAccessToken,
    fields: "id,name,access_token,instagram_business_account{id,username}",
  });
  const data = Array.isArray(payload.data) ? payload.data : [];
  return data.map((raw) => {
    const page = raw as Record<string, unknown>;
    const ig = (page.instagram_business_account ?? null) as Record<string, unknown> | null;
    return {
      pageId: String(page.id ?? ""),
      name: typeof page.name === "string" ? page.name : "",
      pageAccessToken: typeof page.access_token === "string" ? page.access_token : "",
      instagram:
        ig && typeof ig.id === "string"
          ? { id: ig.id, username: typeof ig.username === "string" ? ig.username : null }
          : null,
    };
  }).filter((p) => p.pageId && p.pageAccessToken);
}

/**
 * Subscribe our app to this Page's message webhooks.
 *
 * Without this, Meta accepts the connection but delivers nothing — the inbound
 * processor would sit dormant forever with a Page it can resolve but never hears
 * from. `messages` and `messaging_postbacks` are the fields the inbound parser
 * reads; the same subscription covers the Page's linked Instagram.
 *
 * Best-effort at the call site: a connection whose webhook subscription failed is
 * still stored (it can send), and the failure is logged rather than losing the
 * whole connect.
 */
export async function subscribePageToWebhook(pageId: string, pageAccessToken: string): Promise<void> {
  const url = new URL(`/${env.metaGraphApiVersion}/${pageId}/subscribed_apps`, GRAPH);
  const response = await fetch(url.toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscribed_fields: "messages,messaging_postbacks",
      access_token: pageAccessToken,
    }),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new Error(String(error.message ?? `HTTP ${response.status}`));
  }
}
