import type { PortalListing } from "@nexus/shared";

/**
 * Property Finder's Enterprise API 2.0 (7 Nov 2026) — the only code that knows
 * its addresses.
 *
 * What is public: authentication is OAuth 2.0 client credentials, the API key
 * being the client id and the API secret the client secret, both made by the
 * agency's Decision Maker in PF Expert → Developer Resources → API Credentials.
 * The token request below is the one Property Finder's integration documentation
 * describes (quoted in a Make.com community thread, Jan 2025). What is not
 * public: the listing endpoints and the listing body — they are behind the
 * documentation password. So the four listing calls keep their final shape here
 * and answer "not built yet" until they are written against that documentation
 * (PF_LISTING_CALLS_READY in @nexus/shared keeps the sync from calling them).
 *
 * The key and secret never come back in a message: Property Finder's error text
 * is kept, but anything in it equal to the key or the secret becomes "•••".
 *
 * Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §1, §4
 */

/** PROVISIONAL until Property Finder's documentation is read: the sandbox may have its own address. */
export const PF_ENDPOINTS: Record<"sandbox" | "live", { token: string }> = {
  sandbox: { token: "https://auth.propertyfinder.com/auth/oauth/v1/token" },
  live: { token: "https://auth.propertyfinder.com/auth/oauth/v1/token" },
};

export type PfCredentials = { key: string; secret: string; environment: "sandbox" | "live" };

export type PfAnswer =
  | { ok: true; ref?: string }
  | { ok: false; kind: "refused"; message: string }
  | { ok: false; kind: "unreachable"; message: string }
  | { ok: false; kind: "key-refused"; message: string };

export type PfClient = {
  checkKey(c: PfCredentials): Promise<PfAnswer>;
  createListing(c: PfCredentials, l: PortalListing): Promise<PfAnswer>;
  updateListing(c: PfCredentials, ref: string, l: PortalListing): Promise<PfAnswer>;
  publishListing(c: PfCredentials, ref: string): Promise<PfAnswer>;
  unpublishListing(c: PfCredentials, ref: string): Promise<PfAnswer>;
};

const TIMEOUT_MS = 15_000;
const MESSAGE_MAX = 300;
const NOT_BUILT: PfAnswer = { ok: false, kind: "unreachable", message: "Property Finder's listing calls are not built yet." };

/** Property Finder's words, with the key and secret blanked out, at most 300 characters. */
function said(text: string, c: PfCredentials): string {
  let out = text;
  for (const secret of [c.secret, c.key]) if (secret) out = out.split(secret).join("•••");
  return out.trim().slice(0, MESSAGE_MAX);
}

/** The message in an error body: message, error_description, error — else the status. */
async function bodyMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    for (const k of ["message", "error_description", "error"]) {
      if (typeof body[k] === "string" && body[k]) return body[k] as string;
    }
  } catch {
    // not JSON: fall through to the status
  }
  return `HTTP ${res.status}`;
}

export function makePfClient(fetchFn: typeof fetch = fetch): PfClient {
  return {
    async checkKey(c) {
      let res: Response;
      try {
        res = await fetchFn(PF_ENDPOINTS[c.environment].token, {
          method: "POST",
          headers: {
            authorization: `Basic ${Buffer.from(`${c.key}:${c.secret}`).toString("base64")}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ scope: "openid", grant_type: "client_credentials" }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (err) {
        return { ok: false, kind: "unreachable", message: said(err instanceof Error ? err.message : String(err), c) };
      }
      if (res.status === 401 || res.status === 403) return { ok: false, kind: "key-refused", message: said(await bodyMessage(res), c) };
      if (res.status >= 400 && res.status < 500) return { ok: false, kind: "refused", message: said(await bodyMessage(res), c) };
      if (!res.ok) return { ok: false, kind: "unreachable", message: `HTTP ${res.status}` };
      const body = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
      if (!body || typeof body.access_token !== "string" || !body.access_token) {
        return { ok: false, kind: "unreachable", message: "Property Finder answered without a token" };
      }
      return { ok: true };
    },
    // Not built until Property Finder's listing format is known (see above).
    createListing: async () => NOT_BUILT,
    updateListing: async () => NOT_BUILT,
    publishListing: async () => NOT_BUILT,
    unpublishListing: async () => NOT_BUILT,
  };
}

export const pfClient: PfClient = makePfClient();
