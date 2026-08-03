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
};
