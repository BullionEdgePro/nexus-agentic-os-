/**
 * Onboarding a staff member's OWN WhatsApp Business app number, via Coexistence.
 *
 * ============================================================
 * WHAT COEXISTENCE IS, AND WHY IT NEEDED NO NEW APP
 * ============================================================
 *
 * A number on the WhatsApp Business app used to be a number the Cloud API could
 * not touch — one number, one place, and connecting it here meant taking it off
 * the app. Meta's Coexistence flow ends that: the number stays on the Business
 * app AND joins the Cloud API at once, and messages sync both ways. So a staff
 * member keeps chatting on their phone and the same conversations appear in
 * Nexus, which is exactly what was asked for and was previously impossible.
 *
 * It extends the EXISTING WhatsApp app — the one the shared company number
 * already runs on — so the app id's secret and the system-user token are the
 * ones already in the environment. What is new is only the front door: Embedded
 * Signup, a Meta-hosted popup the staff member completes on their own phone,
 * which hands back a short-lived `code` plus the WABA and phone-number ids it
 * created. This module turns that into a usable, subscribed connection.
 *
 * ============================================================
 * DORMANT UNTIL CONFIGURED
 * ============================================================
 *
 * `whatsappCoexistenceConfigured()` is false until the app id AND the Embedded
 * Signup configuration id are both set. Every route guards on it, so a server
 * that has not been given a real configuration offers the feature as
 * "not enabled yet" rather than half-working — the same honesty the TikTok and
 * Gmail connections already practise about what they can and cannot do.
 */
import { env } from "../config/env.js";
import { logger } from "./logger.js";

const graph = () => `https://graph.facebook.com/${env.metaGraphApiVersion}`;

/**
 * Is coexistence actually usable on this server?
 *
 * All four are required: the public app id and the Embedded Signup
 * configuration id the browser needs to open the popup, and the app secret plus
 * a system-user token the callback needs to exchange the returned code and
 * subscribe the number. Missing any one is "not enabled yet", not a runtime
 * error later.
 */
export function whatsappCoexistenceConfigured(): boolean {
  if (!env.metaAppId || !env.metaWhatsappEmbeddedConfigId) return false;
  // These two throw if unset (`required`), so read them defensively — the point
  // here is a boolean, never an exception on a status check.
  try {
    return Boolean(env.metaAppSecret && env.metaAccessToken);
  } catch {
    return false;
  }
}

/** What the browser needs to open Meta's Embedded Signup popup. All public. */
export function whatsappEmbeddedConfig(): {
  configured: boolean;
  appId: string;
  configId: string;
  graphVersion: string;
} {
  return {
    configured: whatsappCoexistenceConfigured(),
    appId: env.metaAppId,
    configId: env.metaWhatsappEmbeddedConfigId,
    graphVersion: env.metaGraphApiVersion,
  };
}

/**
 * Exchange the Embedded Signup `code` for a business access token.
 *
 * The code is single-use and short-lived; this is the only moment it is worth
 * anything. Exchanged against the SAME app id and secret the shared number uses,
 * because coexistence is a capability of that app, not a second one.
 */
export async function exchangeEmbeddedSignupCode(code: string): Promise<string> {
  const url =
    `${graph()}/oauth/access_token` +
    `?client_id=${encodeURIComponent(env.metaAppId)}` +
    `&client_secret=${encodeURIComponent(env.metaAppSecret)}` +
    `&code=${encodeURIComponent(code)}`;

  const response = await fetch(url);
  const data = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    error?: { message?: string };
  };
  if (!response.ok || !data.access_token) {
    const reason = data.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Could not complete the WhatsApp sign-in: ${reason}`);
  }
  return data.access_token;
}

/**
 * Subscribe THIS app to the newly-connected WABA so its webhooks reach us.
 *
 * Without this, the number is connected but silent here: Meta delivers its
 * messages to whichever apps are subscribed, and a fresh WABA has none. Idempotent
 * at Meta's end — subscribing an already-subscribed app is a no-op, not an error —
 * so it is safe to run on every (re)connect.
 */
export async function subscribeAppToWaba(wabaId: string, businessToken: string): Promise<void> {
  const response = await fetch(`${graph()}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${businessToken}` },
  });
  if (!response.ok) {
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(
      `Connected, but could not subscribe for messages: ${data.error?.message ?? `HTTP ${response.status}`}`
    );
  }
}

/**
 * The dialable number and verified name behind a phone_number_id.
 *
 * Read so the connection shows the staff member the number they just linked, in
 * a form they recognise, rather than Meta's opaque id. Best-effort: a failure
 * here must not undo a connection that otherwise worked, so the caller treats a
 * null as "connected, details unknown".
 */
export async function fetchCoexistenceNumber(
  phoneNumberId: string,
  businessToken: string
): Promise<{ displayNumber: string | null; verifiedName: string | null }> {
  try {
    const response = await fetch(
      `${graph()}/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${businessToken}` } }
    );
    if (!response.ok) return { displayNumber: null, verifiedName: null };
    const data = (await response.json()) as {
      display_phone_number?: string;
      verified_name?: string;
    };
    return {
      displayNumber: data.display_phone_number ?? null,
      verifiedName: data.verified_name ?? null,
    };
  } catch (err) {
    logger.warn({ err, phoneNumberId }, "Could not read the coexistence number's details");
    return { displayNumber: null, verifiedName: null };
  }
}
