import type { MiddlewareHandler } from "hono";
import { env } from "../config/env.js";
import { verifySessionToken, readCookie, SESSION_COOKIE } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * Require an authenticated operator for /api/*.
 *
 * Two accepted credentials:
 *  - the operator session cookie issued by apps/web (browser traffic), and
 *  - an `Authorization: Bearer <NEXUS_API_TOKEN>` header (scripts, future
 *    service integrations).
 *
 * NOT applied to /webhooks/whatsapp — Meta cannot present either credential,
 * and that endpoint authenticates differently and correctly already, by
 * verifying an HMAC signature over the raw request body.
 *
 * /health stays open so uptime checks and Caddy probes keep working; it
 * returns no tenant data.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const presented = authorization.slice(7).trim();
    // An unset NEXUS_API_TOKEN must not turn an empty bearer into a valid one.
    if (env.apiToken && presented === env.apiToken) return next();
  }

  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  const session = await verifySessionToken(token, env.sessionSecret);
  if (session) {
    c.set("operator", session.sub);
    return next();
  }

  logger.warn(
    { path: c.req.path, method: c.req.method },
    "Rejected unauthenticated request to a tenant-data endpoint"
  );
  return c.json({ error: "Unauthorized" }, 401);
};
