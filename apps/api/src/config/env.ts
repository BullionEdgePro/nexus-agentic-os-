import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// `npm run dev -w apps/api` runs with cwd = apps/api, so dotenv's default
// "look for .env in process.cwd()" misses the monorepo-root .env entirely —
// load it explicitly, regardless of which directory this was launched from.
const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "..", "..", "..", "..", ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  apiPort: Number(process.env.API_PORT ?? 8080),
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:3000",

  /**
   * Browser origins allowed to call /api/*.
   *
   * WEB_ORIGIN accepts a comma-separated list because the app is served from
   * more than one hostname: the Unified Inbox lives at app.<domain> and the
   * same build is also served on the bare <domain>. A single-origin CORS
   * allowlist silently broke the bare domain — every API call failed with
   * "Failed to fetch" and the UI rendered an empty, entirely plausible-looking
   * "No conversations yet" instead of an error.
   */
  get webOrigins(): string[] {
    return (process.env.WEB_ORIGIN ?? "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, "")) // trailing slash never matches an Origin header
      .filter(Boolean);
  },

  /**
   * Where to post when a problem STARTS. Empty means nowhere, which is the
   * behaviour the platform had before alerting existed.
   *
   * Any URL that accepts a JSON POST: a Slack or Discord incoming webhook, a
   * relay, an endpoint of your own. Nothing is sent until this is set, and what
   * is sent carries no customer name, no message body and no finding title --
   * only which business, which operator, how severe, and a link back into the
   * deck. See services/alert-dispatch.ts for why that boundary is where it is.
   *
   * Validated on read rather than trusted: a malformed value disables alerting
   * loudly at boot instead of failing once, silently, at 3am on the sweep that
   * mattered.
   */
  get operatorAlertWebhookUrl(): string | null {
    const raw = (process.env.OPERATOR_ALERT_WEBHOOK_URL ?? "").trim();
    if (!raw) return null;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(
        `OPERATOR_ALERT_WEBHOOK_URL is not a URL: ${JSON.stringify(raw)}. ` +
          "Unset it to disable operator alerts."
      );
    }
    if (parsed.protocol !== "https:") {
      // The payload names businesses and what is wrong with them. That is not a
      // customer's data, and it is still not something to post in clear text.
      throw new Error(
        `OPERATOR_ALERT_WEBHOOK_URL must be https, got ${parsed.protocol}. ` +
          "Unset it to disable operator alerts."
      );
    }
    return parsed.toString();
  },

  /**
   * Whether a warning is worth a notification, or only an urgent finding is.
   *
   * Off by default. "A customer has waited two hours" belongs on a page; a
   * phone buzzing for it at 3am is how somebody learns to mute the channel
   * before the night it matters.
   */
  get operatorAlertOnWarn(): boolean {
    return (process.env.ALERT_ON_WARN ?? "").toLowerCase() === "true";
  },

  get metaAppSecret() {
    return required("META_APP_SECRET");
  },
  get metaWebhookVerifyToken() {
    return required("META_WEBHOOK_VERIFY_TOKEN");
  },
  get metaAccessToken() {
    return required("META_ACCESS_TOKEN");
  },
  metaGraphApiVersion: process.env.META_GRAPH_API_VERSION ?? "v21.0",

  /**
   * WhatsApp Embedded Signup — for staff connecting their OWN WhatsApp Business
   * app number via Coexistence (keep the app, also connect to Nexus).
   *
   * BOTH OPTIONAL, and the feature is off until both are set. `metaAppId` is the
   * public app id the browser hands to Meta's JS SDK; `metaWhatsappEmbeddedConfigId`
   * is the Embedded Signup configuration created in the app dashboard with the
   * coexistence option turned on. Until a real config exists these are empty and
   * `whatsappCoexistenceConfigured()` reports the feature as not-yet-enabled —
   * so nothing here changes behaviour on a server that has not set them.
   *
   * The app SECRET and the system-user ACCESS TOKEN it exchanges against are the
   * same ones the shared number already uses (META_APP_SECRET / META_ACCESS_TOKEN),
   * because coexistence extends the existing WhatsApp app rather than a new one.
   */
  metaAppId: process.env.META_APP_ID ?? "",
  metaWhatsappEmbeddedConfigId: process.env.META_WHATSAPP_ESU_CONFIG_ID ?? "",

  /** Shared with apps/web so one operator login authenticates the UI and the API. */
  sessionSecret: process.env.NEXUS_SESSION_SECRET ?? "nexus-dev-secret-change-me",

  /**
   * Service-to-service bearer token for non-browser callers (scripts, future
   * integrations). Optional: when unset, only session cookies are accepted,
   * which is the safer default — an empty token must never authenticate
   * anything.
   */
  apiToken: process.env.NEXUS_API_TOKEN ?? "",
};
