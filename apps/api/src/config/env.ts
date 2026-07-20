import "dotenv/config";

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
