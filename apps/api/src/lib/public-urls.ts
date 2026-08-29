/**
 * Where this deployment lives, from the outside.
 *
 * ============================================================
 * TWO ADDRESSES THAT ARE NOT THE SAME ADDRESS
 * ============================================================
 *
 * The API and the console are separate hosts behind the same proxy —
 * `api.example.com` reverse-proxies the API container, `app.example.com` the web
 * one. An OAuth flow touches both, in this order:
 *
 *   1. the redirect_uri Google or TikTok sends the browser back to, which is an
 *      API endpoint and must be the API host;
 *   2. the console page the browser is then bounced to, which is a page and must
 *      be the web host.
 *
 * Conflating them is easy and fails late. Point the redirect_uri at the web host
 * and the provider returns `redirect_uri_mismatch`, or — worse, if the mismatch
 * is only in the fallback — the browser lands on a 404 at the proxy with the
 * authorization code still in the URL, and the person sees a broken page with no
 * idea their consent went nowhere.
 *
 * So they are two functions with two names, derived from the two variables the
 * proxy already reads. Nothing here needs a new setting to be configured for the
 * ordinary deployment.
 */

const strip = (value: string): string => value.trim().replace(/\/+$/, "");

/**
 * The public origin of THIS API — where a provider sends the browser back.
 *
 * `PUBLIC_API_URL` wins if set, for a deployment that fronts the API somewhere
 * else entirely. Otherwise it is built from the same `API_DOMAIN` the reverse
 * proxy uses, so the two cannot drift apart.
 */
export function apiBaseUrl(): string {
  const explicit = process.env.PUBLIC_API_URL?.trim();
  if (explicit) return strip(explicit);

  const domain = process.env.API_DOMAIN?.trim();
  if (domain) return `https://${strip(domain).replace(/^https?:\/\//, "")}`;

  return "https://api.nexusagenticos.com";
}

/**
 * The public origin of the CONSOLE — where a person is sent afterwards.
 *
 * `PUBLIC_APP_URL` wins if set; otherwise `WEB_DOMAIN`, which is what the proxy
 * serves the console on.
 */
export function appBaseUrl(): string {
  const explicit = process.env.PUBLIC_APP_URL?.trim();
  if (explicit) return strip(explicit);

  const domain = process.env.WEB_DOMAIN?.trim();
  if (domain) return `https://${strip(domain).replace(/^https?:\/\//, "")}`;

  return "https://app.nexusagenticos.com";
}
