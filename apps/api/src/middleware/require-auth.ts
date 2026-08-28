import type { MiddlewareHandler } from "hono";
import { env } from "../config/env.js";
import { verifySessionToken, readCookie, SESSION_COOKIE, type SessionScope } from "../lib/session.js";
import { findOrganizationBySlug } from "@nexus/db";
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
/**
 * "Show me what my staff can see."
 *
 * ============================================================
 * WHY THIS IS SERVER-SIDE AND NOT A UI TOGGLE
 * ============================================================
 *
 * The obvious version scopes the CONSOLE and leaves the API alone, and it lies.
 * The screens would narrow while every response still carried an operator's
 * full data, so the owner would be shown a staff-shaped window over their own
 * access and told it was what staff get. On a platform whose whole promise is
 * that one business cannot see another's customers, a preview that only pretends
 * is worse than none.
 *
 * So the DOWNGRADE HAPPENS HERE, at the one place a scope is decided, and every
 * route below behaves exactly as it would for a real employee without any of
 * them knowing this feature exists.
 *
 * ============================================================
 * IT CAN ONLY EVER NARROW
 * ============================================================
 *
 * The only transition is operator -> employee-of-one-business. There is no path
 * that widens anything, which is what makes it safe to drive from a header:
 *
 *   - An employee sending it is unaffected. Only an operator session is
 *     downgraded, so the header cannot move somebody sideways into a business
 *     that is not theirs.
 *   - A bearer-token caller is unaffected, deliberately. Scripts must not have
 *     their access changed by a header a proxy might add.
 *   - An unknown slug is REFUSED rather than ignored. Ignoring it would serve
 *     operator data underneath a banner promising a staff view, which is the
 *     exact shape of defect this repository keeps recording.
 *
 * WHAT IT CANNOT SHOW. There is no employeeId, because the owner is not one of
 * their staff. Screens keyed on "assigned to me" will be empty, and that is
 * honest rather than broken -- the console says so in the banner rather than
 * letting an empty follow-up list read as a claim about the business.
 */
const VIEW_AS_HEADER = "x-nexus-view-as";

async function previewScope(
  c: Parameters<MiddlewareHandler>[0],
  session: SessionScope
): Promise<{ scope: SessionScope } | { error: string }> {
  const slug = c.req.header(VIEW_AS_HEADER)?.trim();
  if (!slug) return { scope: session };
  if (session.role !== "operator") return { scope: session };

  const organization = await findOrganizationBySlug(slug);
  if (!organization) {
    logger.warn({ slug, sub: session.sub }, "Refused a staff preview for an unknown business");
    return { error: `No business called "${slug}".` };
  }

  logger.info({ sub: session.sub, viewingAs: organization.slug }, "Operator is previewing as staff");
  return {
    scope: {
      sub: session.sub,
      role: "employee",
      organizationId: organization.id,
      organizationSlug: organization.slug,
    },
  };
}

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

    const viewing = await previewScope(c, session);
    if ("error" in viewing) return c.json({ error: viewing.error }, 400);

    c.set("scope", viewing.scope);
    return next();
  }

  logger.warn(
    { path: c.req.path, method: c.req.method },
    "Rejected unauthenticated request to a tenant-data endpoint"
  );
  return c.json({ error: "Unauthorized" }, 401);
};
