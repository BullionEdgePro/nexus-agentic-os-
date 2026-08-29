/**
 * Gmail, for a staff member's work with their own clients.
 *
 * ============================================================
 * THIS IS THE MOST INVASIVE THING ON THE PLATFORM
 * ============================================================
 *
 * A WhatsApp conversation here is business correspondence on a business number.
 * A person's mailbox is not that. It holds their bank, their doctor, their
 * arguments — and the token this stores can read all of it, because Gmail has
 * no scope for "only mail from these people".
 *
 * So the platform draws a line the API does not: it NEVER lists the mailbox. It
 * only ever queries for mail involving addresses already in that person's own
 * client book, and if the book is empty it fetches nothing at all. The console
 * cannot show an inbox because the server never asks for one.
 *
 * That is a product decision rather than a security boundary, and it is worth
 * being honest about which: somebody with the database and the key could read
 * anything the token permits. What it prevents is the ordinary failure — a
 * colleague glancing at a screen, a screenshot in a support thread, a feature
 * added later that lists "recent mail" because the data was right there.
 *
 * ============================================================
 * WHY THE CONSENT SCREEN MATTERS MORE THAN THE CODE
 * ============================================================
 *
 * `gmail.readonly` is a RESTRICTED scope. For an app used by people outside the
 * publisher's own Workspace, Google requires verification and an independent
 * security assessment — months, and thousands of dollars.
 *
 * For a team on one Workspace the owner controls, an INTERNAL consent screen
 * skips all of it: the app is not published, only accounts in that Workspace
 * can consent, and no review applies. That is the intended deployment here, and
 * it is why this is achievable in days rather than never.
 */

import { apiBaseUrl } from "./public-urls.js";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * What is asked for.
 *
 * `gmail.readonly` reads; `gmail.send` sends without granting the ability to
 * modify or delete anything. `gmail.modify` would cover both and is deliberately
 * NOT used — it also permits deleting a person's mail, which nothing here does
 * and no consent screen should have to explain.
 */
const ALL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;

export function gmailScopes(): string[] {
  const configured = process.env.GMAIL_SCOPES?.trim();
  if (!configured) return [...ALL_SCOPES];
  const scopes = configured.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  return scopes.length > 0 ? scopes : [...ALL_SCOPES];
}

export function gmailConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function gmailRedirectUri(): string {
  // The redirect_uri is an API endpoint, so it is the API host — not the app
  // host. Pointing it at the console returns redirect_uri_mismatch from Google.
  return process.env.GOOGLE_REDIRECT_URI || `${apiBaseUrl()}/api/connections/gmail/callback`;
}

/**
 * Where Google asks the person to consent.
 *
 * `access_type=offline` with `prompt=consent` is not belt and braces — Google
 * returns a refresh token ONLY on a consent that includes both, and only the
 * first time unless consent is forced. Without it the connection works for an
 * hour and then dies with no way to renew, which is the kind of failure that
 * looks like the platform breaking a week later.
 */
export function gmailAuthorizeUrl(state: string): string {
  const url = new URL(AUTH);
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID ?? "");
  url.searchParams.set("redirect_uri", gmailRedirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", gmailScopes().join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export interface GoogleToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
}

export async function exchangeGoogleCode(code: string): Promise<GoogleToken> {
  const response = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      redirect_uri: gmailRedirectUri(),
      grant_type: "authorization_code",
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    throw new Error(
      `Google refused the sign-in: ${String(payload.error_description ?? payload.error ?? response.status)}`
    );
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  return {
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : null,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    scopes:
      typeof payload.scope === "string" && payload.scope
        ? payload.scope.split(/\s+/).filter(Boolean)
        : gmailScopes(),
  };
}

/**
 * A fresh access token from the stored refresh token.
 *
 * Google's access tokens last an hour, so this runs far more often than the
 * consent does. A refresh that fails with `invalid_grant` means the person
 * revoked access or changed their password — permanent, and the caller must say
 * "connect it again" rather than retrying forever.
 */
export async function refreshGoogleToken(refreshToken: string): Promise<GoogleToken> {
  const response = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_CLIENT_ID ?? "",
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const error = String(payload.error ?? response.status);
    throw new Error(
      error === "invalid_grant"
        ? "GMAIL_RECONNECT: access was revoked or the password changed."
        : `Could not refresh the Google sign-in: ${error}`
    );
  }

  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : null;
  return {
    accessToken: payload.access_token,
    // A refresh response does not return a new refresh token. Returning null
    // here and having the caller keep the existing one is deliberate: writing
    // null over a working refresh token is a connection that dies in an hour.
    refreshToken: null,
    expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    scopes:
      typeof payload.scope === "string" && payload.scope
        ? payload.scope.split(/\s+/).filter(Boolean)
        : [],
  };
}

async function gmailGet(path: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new Error(String(error.message ?? `HTTP ${response.status}`));
  }
  return payload;
}

/** Which mailbox this is. Shown so a person can see WHICH account they connected. */
export async function fetchGmailProfile(
  accessToken: string
): Promise<{ emailAddress: string; messagesTotal: number | null }> {
  const payload = await gmailGet("/profile", accessToken);
  return {
    emailAddress: String(payload.emailAddress ?? ""),
    messagesTotal: typeof payload.messagesTotal === "number" ? payload.messagesTotal : null,
  };
}

export interface MailHeader {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  snippet: string | null;
  receivedAt: string | null;
  unread: boolean;
}

const header = (headers: Array<Record<string, unknown>>, name: string): string | null => {
  const found = headers.find((h) => String(h.name ?? "").toLowerCase() === name);
  return found && typeof found.value === "string" ? found.value : null;
};

/**
 * Mail involving these people, and nobody else.
 *
 * ============================================================
 * THE ADDRESS LIST IS THE WHOLE PRIVACY DESIGN
 * ============================================================
 *
 * Gmail's query language is the only filter available, so the restriction has
 * to be expressed as a search: `{from:a to:a from:b to:b}` is an OR over the
 * addresses in this person's client book. Nothing else matches, so nothing else
 * is returned, and there is no code path here that omits the query.
 *
 * An EMPTY address list returns immediately with nothing. That case matters
 * more than it looks: a `q` built from no addresses would be an empty query,
 * and an empty query to Gmail means EVERY MESSAGE. The one line that guards it
 * is the difference between a client mailbox and somebody's whole life.
 */
export async function fetchClientMail(
  accessToken: string,
  addresses: string[],
  limit = 20
): Promise<MailHeader[]> {
  const clean = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  if (clean.length === 0) return [];

  const query = `{${clean.map((a) => `from:${a} to:${a}`).join(" ")}}`;
  const list = await gmailGet(
    `/messages?maxResults=${Math.min(limit, 50)}&q=${encodeURIComponent(query)}`,
    accessToken
  );

  const ids = Array.isArray(list.messages) ? list.messages : [];
  if (ids.length === 0) return [];

  // METADATA format, not FULL. The headers and Gmail's own snippet are what the
  // screen shows, and asking for the body would pull the entire correspondence
  // through this server for no reason anybody could point at.
  const messages = await Promise.all(
    ids.slice(0, limit).map(async (raw) => {
      const id = String((raw as Record<string, unknown>).id ?? "");
      if (!id) return null;
      try {
        const message = await gmailGet(
          `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
          accessToken
        );
        const payload = (message.payload ?? {}) as Record<string, unknown>;
        const headers = Array.isArray(payload.headers)
          ? (payload.headers as Array<Record<string, unknown>>)
          : [];
        const labels = Array.isArray(message.labelIds) ? (message.labelIds as string[]) : [];
        const internal = message.internalDate;

        return {
          id,
          threadId: String(message.threadId ?? ""),
          from: header(headers, "from"),
          to: header(headers, "to"),
          subject: header(headers, "subject"),
          snippet: typeof message.snippet === "string" ? message.snippet : null,
          receivedAt:
            typeof internal === "string" && internal
              ? new Date(Number(internal)).toISOString()
              : null,
          unread: labels.includes("UNREAD"),
        } satisfies MailHeader;
      } catch {
        // One unreadable message must not lose the other nineteen.
        return null;
      }
    })
  );

  return messages.filter((m): m is MailHeader => m !== null);
}

/**
 * Send one, as the connected account.
 *
 * RFC 2822 assembled here rather than by a library: the message is a subject, a
 * recipient and a body, and a dependency for three headers is a dependency to
 * keep updated for as long as this exists.
 */
export async function sendGmail(
  accessToken: string,
  input: { to: string; subject: string; body: string }
): Promise<string> {
  // Folded per RFC 2047 so a non-ASCII subject is not mangled. Bodies are
  // base64 anyway, so only the subject needs it.
  const subject = `=?UTF-8?B?${Buffer.from(input.subject, "utf8").toString("base64")}?=`;
  const mime = [
    `To: ${input.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(input.body, "utf8").toString("base64"),
  ].join("\r\n");

  const response = await fetch(`${API}/messages/send`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(mime, "utf8").toString("base64url") }),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const error = (payload.error ?? {}) as Record<string, unknown>;
    throw new Error(String(error.message ?? `HTTP ${response.status}`));
  }
  return String(payload.id ?? "");
}
