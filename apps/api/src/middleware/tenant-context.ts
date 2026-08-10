import type { MiddlewareHandler } from "hono";
import { findOrganizationBySlug, withTenant, withAllTenants } from "@nexus/db";
import { logger } from "../lib/logger.js";

/**
 * Establishes the database tenant context for the whole request.
 *
 * Applied at the router so a new endpoint is scoped by default, in the same
 * spirit as `requireAuth` above it. The alternative — each handler opening its
 * own context — is the pattern that produced the problem this replaces: it
 * works until someone forgets, and forgetting is invisible.
 *
 * A request addressed to one business (`/api/organizations/:slug/...`) gets a
 * tenant context. Everything else gets an explicit cross-tenant context with a
 * stated reason, because on this platform the operator console genuinely does
 * span all five businesses — the inbox is meant to show every conversation, and
 * "every business's metrics" has no per-tenant form.
 *
 * Note what this middleware is not: it is not authorisation. `requireTenantScope`
 * and `operatorOnly` already decide who may reach what, and they run first. This
 * decides which rows the database will hand back once that question is settled.
 */
export const tenantContext: MiddlewareHandler = async (c, next) => {
  const slug = c.req.param("slug");

  if (slug) {
    const organization = await findOrganizationBySlug(slug);
    // A missing organization is left to the route to answer with a 404. Failing
    // here would turn every unknown slug into a 500 and lose the distinction
    // between "no such business" and "something broke".
    if (organization) {
      return withTenant(organization.id, () => next());
    }
  }

  return withAllTenants(`api ${c.req.method} ${new URL(c.req.url).pathname}`, () => next());
};

/**
 * The webhook path, which cannot know its tenant up front.
 *
 * An inbound WhatsApp message arrives identified by phone number id, and the
 * lookup from that to an organization is itself a database query — so the
 * request has to begin cross-tenant and narrow once the answer is known. This
 * is the second of the two legitimate cross-tenant entry points named in
 * ARCHITECTURE-ABOS.md §2.2; the routing lookup is the whole reason it exists.
 */
export const webhookContext: MiddlewareHandler = async (c, next) => {
  return withAllTenants("whatsapp webhook: phone_number_id resolves to a tenant", async () => {
    try {
      await next();
    } catch (err) {
      logger.error({ err }, "Webhook failed inside tenant context");
      throw err;
    }
  });
};
