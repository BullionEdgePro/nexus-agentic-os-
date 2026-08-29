import { createHash, randomBytes } from "node:crypto";

/**
 * TikTok, for what TikTok actually permits.
 *
 * ============================================================
 * THERE IS NO INBOX. SAYING SO ONCE, HERE.
 * ============================================================
 *
 * TikTok publishes Login Kit, the Display API and Content Posting. None of them
 * exposes direct messages, at any tier, to anybody. "Manage clients on TikTok"
 * in the messaging sense cannot be built — not by this platform and not by the
 * tools that advertise it.
 *
 * What this connection is for instead: a staff member puts their referral link
 * in their TikTok bio, and until now nobody could see whether the account
 * carrying it was reaching anyone. Follower count and recent video views, shown
 * beside the conversations that link produced, is a question somebody can act
 * on — post more of what worked, or stop.
 *
 * ============================================================
 * THE SCOPE TRAP, LEARNED THE EXPENSIVE WAY
 * ============================================================
 *
 * TikTok fails an ENTIRE request with `scope_not_authorized` when it is asked
 * for one field the token does not carry — it does not return the fields you
 * are entitled to and omit the rest. So the fields requested are derived from
 * the scopes actually configured, never from a fixed list, and a scope error
 * still falls back to the basics rather than losing the whole connection.
 *
 * That behaviour is ported from this owner's other product, where it was found
 * during a TikTok audit. Repeating the discovery here would have cost the same
 * afternoon.
 */

const API = "https://open.tiktokapis.com/v2";
const AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";

/**
 * Every scope this integration can use.
 *
 * `user.info.basic` is the floor — an authorize URL with no scope at all fails
 * exactly as hard as one asking for something ungranted. The rest are only
 * requested where an installation's audit has cleared them, which is why the
 * set is configurable rather than compiled in.
 */
const ALL_SCOPES = ["user.info.basic", "user.info.profile", "user.info.stats", "video.list"] as const;

export function tiktokScopes(): string[] {
  const configured = process.env.TIKTOK_SCOPES?.trim();
  if (!configured) return [...ALL_SCOPES];
  const scopes = configured
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // Never end up with an empty scope list: that URL fails as hard as a wrong
  // one, and with a much more confusing message.
  return scopes.length > 0 ? scopes : [...ALL_SCOPES];
}

export function tiktokConfigured(): boolean {
  return Boolean(process.env.TIKTOK_CLIENT_KEY && process.env.TIKTOK_CLIENT_SECRET);
}

/** Where TikTok sends the person back. Must match the app's registered URI exactly. */
export function tiktokRedirectUri(): string {
  return (
    process.env.TIKTOK_REDIRECT_URI ||
    `${process.env.PUBLIC_APP_URL || "https://nexusagenticos.com"}/api/connections/tiktok/callback`
  );
}

/**
 * PKCE, which TikTok requires rather than merely accepts.
 *
 * The verifier is held in the signed state cookie rather than in memory: the
 * callback can land on a different worker process than the one that started the
 * flow, and an in-memory map would work perfectly in development and fail
 * intermittently in production behind more than one container.
 */
export function makeVerifier(): string {
  return randomBytes(48).toString("base64url");
}

export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("hex");
}

export function tiktokAuthorizeUrl(state: string, verifier: string): string {
  const url = new URL(AUTHORIZE);
  url.searchParams.set("client_key", process.env.TIKTOK_CLIENT_KEY ?? "");
  url.searchParams.set("scope", tiktokScopes().join(","));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", tiktokRedirectUri());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challengeFor(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TikTokToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  openId: string;
}

export async function exchangeTikTokCode(code: string, verifier: string): Promise<TikTokToken> {
  const body = new URLSearchParams({
    client_key: process.env.TIKTOK_CLIENT_KEY ?? "",
    client_secret: process.env.TIKTOK_CLIENT_SECRET ?? "",
    code,
    grant_type: "authorization_code",
    redirect_uri: tiktokRedirectUri(),
    code_verifier: verifier,
  });

  const response = await fetch(`${API}/oauth/token/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const detail = String(payload.error_description ?? payload.error ?? `HTTP ${response.status}`);
    throw new Error(`TikTok refused the sign-in: ${detail}`);
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    // What TikTok says it GRANTED, which can be narrower than what was asked —
    // the consent screen lets somebody switch individual permissions off.
    scopes:
      typeof payload.scope === "string" && payload.scope
        ? payload.scope.split(/[,\s]+/).filter(Boolean)
        : tiktokScopes(),
    openId: typeof payload.open_id === "string" ? payload.open_id : "",
  };
}

export interface TikTokProfile {
  openId: string;
  displayName: string | null;
  avatarUrl: string | null;
  username: string | null;
  followerCount: number | null;
}

const BASIC_FIELDS = ["open_id", "display_name", "avatar_url"];

/** Only the fields the granted scopes actually cover — see the note above. */
function fieldsFor(scopes: string[]): string {
  const held = new Set(scopes);
  const fields = [...BASIC_FIELDS];
  if (held.has("user.info.profile")) fields.push("username");
  if (held.has("user.info.stats")) fields.push("follower_count");
  return fields.join(",");
}

async function getJson(url: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new Error(String(error.message ?? error.code ?? `HTTP ${response.status}`));
  }
  return payload;
}

/**
 * The connected account.
 *
 * Retried with only the basics when TikTok refuses a scope: somebody can switch
 * an optional permission off on the consent screen after the request was built,
 * and losing a follower count is no reason to fail the whole connection.
 */
export async function fetchTikTokProfile(
  accessToken: string,
  scopes: string[]
): Promise<TikTokProfile> {
  const read = async (fields: string) => {
    const payload = await getJson(`${API}/user/info/?fields=${encodeURIComponent(fields)}`, accessToken);
    const data = (payload.data ?? {}) as Record<string, unknown>;
    return (data.user ?? {}) as Record<string, unknown>;
  };

  const wanted = fieldsFor(scopes);
  let user: Record<string, unknown>;
  try {
    user = await read(wanted);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (wanted === BASIC_FIELDS.join(",") || !/scope_not_authorized/i.test(message)) throw err;
    user = await read(BASIC_FIELDS.join(","));
  }

  return {
    openId: String(user.open_id ?? ""),
    displayName: typeof user.display_name === "string" ? user.display_name : null,
    avatarUrl: typeof user.avatar_url === "string" ? user.avatar_url : null,
    username: typeof user.username === "string" ? user.username : null,
    followerCount: typeof user.follower_count === "number" ? user.follower_count : null,
  };
}

export interface TikTokVideo {
  id: string;
  title: string | null;
  viewCount: number | null;
  likeCount: number | null;
  createdAt: string | null;
  shareUrl: string | null;
}

/**
 * Recent videos, when the token carries `video.list`.
 *
 * Returns an empty list rather than throwing when the scope is absent: a
 * connection without it is still a working connection, and the screen says so
 * rather than showing an error for a permission nobody granted.
 */
export async function fetchTikTokVideos(
  accessToken: string,
  scopes: string[],
  limit = 6
): Promise<TikTokVideo[]> {
  if (!scopes.includes("video.list")) return [];

  const response = await fetch(
    `${API}/video/list/?fields=${encodeURIComponent("id,title,view_count,like_count,create_time,share_url")}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ max_count: Math.min(limit, 20) }),
    }
  );

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new Error(String(error.message ?? error.code ?? `HTTP ${response.status}`));
  }

  const data = (payload.data ?? {}) as Record<string, unknown>;
  const videos = Array.isArray(data.videos) ? data.videos : [];

  return videos.slice(0, limit).map((raw) => {
    const video = raw as Record<string, unknown>;
    return {
      id: String(video.id ?? ""),
      title: typeof video.title === "string" && video.title ? video.title : null,
      viewCount: typeof video.view_count === "number" ? video.view_count : null,
      likeCount: typeof video.like_count === "number" ? video.like_count : null,
      // TikTok returns seconds; everything else on this platform is an ISO
      // string, and a bare epoch reaching a browser renders as 1970.
      createdAt:
        typeof video.create_time === "number"
          ? new Date(video.create_time * 1000).toISOString()
          : null,
      shareUrl: typeof video.share_url === "string" ? video.share_url : null,
    };
  });
}
