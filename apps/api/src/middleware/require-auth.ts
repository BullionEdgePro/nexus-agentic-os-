import type { MiddlewareHandler } from "hono";
import { env } from "../config/env.js";
import { verifySessionToken, readCookie, SESSION_COOKIE, type SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * Require an authenticated caller for /api/*, and record what they may see.
 *
 * Three accepted credentials:
 *  - the operator session cookie issued by apps/web (browser traffic),
 *  - an employee session cookie, scoped to a single business, and
 *  - an `Authorization: Bearer <NEXUS_API_TOKEN>` header (scripts, future
 *    service integrations).
 *
 * NOT applied to /webhooks/whatsapp — Meta cannot present any of these, and
 * that endpoint authenticates differently and correctly already, by verifying
 * an HMAC signature over the raw request body. Also not applied to /auth/*,
 * which is where a session is obtained in the first place.
 *
 * /health stays open so uptime checks and Caddy probes keep working; it
 * returns no tenant data.
 *
 * This middleware only answers "who is this". WHAT they may reach is
 * `requireTenantScope`, applied per router. Keeping the two apart means a new
 * tenant route cannot silently inherit "authenticated, therefore allowed" —
 * which is the shape of the mistake that left this API open to begin with.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  const authorization = c.req.header("authorization");
  if (authorization?.startsWith("Bearer ")) {
    const presented = authorization.slice(7).trim();
    // An unset NEXUS_API_TOKEN must not turn an empty bearer into a valid one.
    if (env.apiToken && presented === env.apiToken) {
      c.set("scope", { sub: "api-token", role: "operator" } satisfies SessionScope);
      return next();
    }
  }

  const token = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  const session = await verifySessionToken(token, env.sessionSecret);
  if (session) {
    c.set("operator", session.sub);
    c.set("scope", session);
    return next();
  }

  logger.warn(
    { path: c.req.path, method: c.req.method },
    "Rejected unauthenticated request to a tenant-data endpoint"
  );
  return c.json({ error: "Unauthorized" }, 401);
};
