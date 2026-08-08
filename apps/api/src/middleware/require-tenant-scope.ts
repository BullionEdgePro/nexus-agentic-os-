import type { Context, MiddlewareHandler } from "hono";
import { findConversationById, getConversationRouting } from "@nexus/db";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * Enforce that an employee only ever reaches their own business.
 *
 * This is the half that matters. Scoping the UI is presentation — an employee
 * who opens devtools can call the API directly, so if the check lives only in
 * the browser then "scoped access" means nothing at all. Every tenant-data
 * route goes through here.
 *
 * Operators are unrestricted by design: the operator account owns all five
 * businesses. The point of this middleware is not to constrain them, it is to
 * make sure an employee token cannot act like one.
 */

function scopeOf(c: Context): SessionScope {
  // requireAuth runs first on every path this is mounted under, so a missing
  // scope is a wiring mistake, not a request the caller controls. Fail closed:
  // an unknown caller is an employee of no business rather than an operator.
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

function deny(c: Context, reason: string, detail: Record<string, unknown>) {
  logger.warn({ path: c.req.path, ...detail }, `Blocked cross-tenant request: ${reason}`);
  return c.json({ error: "You don't have access to that business." }, 403);
}

/**
 * For routes keyed by an organization slug in the path — `/:slug/...`.
 */
export const requireTenantScope: MiddlewareHandler = async (c, next) => {
  const scope = scopeOf(c);
  if (scope.role === "operator") return next();

  const slug = c.req.param("slug");
  // A route mounted here with no :slug is a wiring mistake. Refusing is the
  // safe reading: an employee should not reach an unscoped tenant route.
  if (!slug) return deny(c, "no slug on a tenant-scoped route", { employeeId: scope.employeeId });

  if (slug !== scope.organizationSlug) {
    return deny(c, "slug outside the employee's business", {
      employeeId: scope.employeeId,
      requested: slug,
      allowed: scope.organizationSlug,
    });
  }

  return next();
};

/**
 * For routes keyed by a conversation id.
 *
 * Compares against the SERVING business — `routed_organization_id` where the
 * switchboard set one, otherwise the owner. On a shared number those differ:
 * every conversation is owned by the number's owner, so checking the owner
 * would let one business's staff open every other business's conversations,
 * which on this platform is all of them.
 */
export const requireConversationScope: MiddlewareHandler = async (c, next) => {
  const scope = scopeOf(c);
  if (scope.role === "operator") return next();

  const conversationId = c.req.param("conversationId") ?? c.req.param("id");
  if (!conversationId) {
    return deny(c, "no conversation id on a conversation-scoped route", {
      employeeId: scope.employeeId,
    });
  }

  const conversation = await findConversationById(conversationId);
  // 404 rather than 403 for a conversation that does not exist, so the response
  // cannot be used to probe which ids are real.
  if (!conversation) return c.json({ error: "Conversation not found" }, 404);

  let servingId = conversation.organizationId;
  try {
    const routing = await getConversationRouting(conversationId);
    if (routing?.routedOrganizationId) servingId = routing.routedOrganizationId;
  } catch (err) {
    // Fail closed. If we cannot tell which business a conversation belongs to,
    // an employee does not get it — the alternative is granting access on the
    // strength of a failed lookup.
    logger.error({ conversationId, err }, "Routing lookup failed during scope check");
    return deny(c, "could not determine the serving business", {
      employeeId: scope.employeeId,
      conversationId,
    });
  }

  if (servingId !== scope.organizationId) {
    return deny(c, "conversation belongs to another business", {
      employeeId: scope.employeeId,
      conversationId,
    });
  }

  return next();
};

/**
 * For routes that span every tenant — the cross-business metrics overview and
 * the full organization list. There is no scoped version of "all businesses",
 * so an employee is refused outright rather than served a filtered shape the
 * UI would have to be trusted to interpret.
 */
export const operatorOnly: MiddlewareHandler = async (c, next) => {
  const scope = scopeOf(c);
  if (scope.role === "operator") return next();
  return deny(c, "operator-only endpoint", { employeeId: scope.employeeId });
};
