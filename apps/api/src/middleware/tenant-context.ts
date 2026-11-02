import type { Context, MiddlewareHandler, Next } from "hono";
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
  // Defined only where this is mounted at `/api/organizations/:slug/*` (index.ts):
  // Hono middleware on `/api/*` never sees `:slug`. That mount runs first, so the
  // later `/api/*` one nests inside it and keeps the business (3 Nov 2026).
  const slug = c.req.param("slug");

  if (slug) {
    const organization = await findOrganizationBySlug(slug);
    // A missing organization is left to the route to answer with a 404. Failing
    // here would turn every unknown slug into a 500 and lose the distinction
    // between "no such business" and "something broke".
    if (organization) {
      const reason = crossTenantReason(c.req.method, c.req.path.replace(/^\/api\/organizations\/[^/]+/, ""));
      if (reason) return inTransaction((work) => withAllTenants(reason, work, REQUEST), c, next);
      return inTransaction((work) => withTenant(organization.id, work, REQUEST), c, next);
    }
  }

  return inTransaction((work) => withAllTenants(`api ${c.req.method} ${new URL(c.req.url).pathname}`, work, REQUEST), c, next);
};

/**
 * A request whose commit lost writes answers 500, not the 200 its handler
 * built (3 Nov 2026): somebody is waiting to be told. Jobs log it instead,
 * because their retry would repeat what they already did outside the database.
 */
const REQUEST = { failOnLostWrites: true };

/** Thrown inside a request's transaction when its handler threw, so its work is rolled back. */
class HandlerFailed extends Error {}

/**
 * Runs the rest of the request inside the transaction `open` starts, and rolls
 * it back when the handler THREW (3 Nov 2026).
 *
 * Hono answers a thrown error with a 500 itself and never rethrows it into the
 * middleware -- `await next()` resolves, with the error on `c.error` -- so the
 * transaction used to commit whatever the handler wrote before it threw. Now
 * the failure is turned back into a throw inside the transaction, which rolls
 * it back, and swallowed outside it, so Hono's 500 stands. An answer the
 * handler chose itself, at any status, commits: a deliberate error response may
 * be recording a failure on purpose.
 *
 * Through the double mount the inner `/api/*` run swallows its own failure and
 * the outer business run sees the same `c.error`, so the business transaction
 * is the one rolled back.
 */
async function inTransaction(
  open: (work: () => Promise<void>) => Promise<void>,
  c: Context,
  next: Next
): Promise<void> {
  try {
    await open(async () => {
      await next();
      if (c.error) throw new HandlerFailed();
    });
  } catch (err) {
    if (!(err instanceof HandlerFailed)) throw err;
  }
}

/**
 * The business-scoped routes that must span businesses, each with its reason.
 *
 * All five businesses share one WhatsApp business account, so the number an
 * operator gives one person may be held by an employee of ANOTHER business.
 * These three free it from whoever held it (`assignEmployeeWhatsAppNumber`), and
 * under that business's own tenant they could reach only its own employees --
 * leaving two people holding one number and the wrong business answering.
 * Operator-only in their router. Matched on the method and the path after
 * `/api/organizations/:slug`; anything not listed runs as its business.
 */
export const CROSS_TENANT_ROUTES: { method: string; path: RegExp; reason: string }[] = [
  {
    method: "POST",
    path: /^\/employees\/[^/]+\/whatsapp-connect$/,
    reason: "connecting a number frees it from whichever business's employee held it on the shared account",
  },
  {
    method: "PATCH",
    path: /^\/employees\/[^/]+\/whatsapp-number$/,
    reason: "assigning a number frees it from whichever business's employee held it on the shared account",
  },
  {
    method: "POST",
    path: /^\/whatsapp-numbers\/[^/]+\/verify$/,
    reason: "a verified number given to someone is freed from whichever business's employee held it",
  },
];

/** Why a business-scoped request must span businesses, or null when it runs as its business. */
export function crossTenantReason(method: string, pathAfterSlug: string): string | null {
  const route = CROSS_TENANT_ROUTES.find((r) => r.method === method.toUpperCase() && r.path.test(pathAfterSlug));
  return route ? `api ${route.method} /api/organizations/:slug${pathAfterSlug}: ${route.reason}` : null;
}

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
  return inTransaction(
    (work) =>
      withAllTenants("whatsapp webhook: phone_number_id resolves to a tenant", async () => {
        try {
          await work();
        } catch (err) {
          // A handler that threw is rolled back (inTransaction) and Hono has
          // already answered and logged it; anything else is this layer's own.
          if (!(err instanceof HandlerFailed)) logger.error({ err }, "Webhook failed inside tenant context");
          throw err;
        }
      }, REQUEST),
    c,
    next
  );
};
