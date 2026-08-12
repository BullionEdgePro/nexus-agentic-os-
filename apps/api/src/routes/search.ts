import { Hono } from "hono";
import { search } from "@nexus/db";
import type { SessionScope } from "../lib/session.js";
import { logger } from "../lib/logger.js";

/**
 * The header search.
 *
 * Same scoping shape as /api/tasks and /api/operators, and for the same reason:
 * this path carries no :slug, so `requireTenantScope` does not apply and the
 * request runs in a cross-tenant database context. An employee whose term was
 * not narrowed here would search five businesses' customers by name — which is
 * the single widest read available on this platform.
 */
export const searchRoute = new Hono();

function scopeOf(c: { get: (k: string) => unknown }): SessionScope {
  // Fail closed: an unrecognised caller is an employee of no business, which
  // resolves to zero rows rather than to everything.
  return (c.get("scope") as SessionScope | undefined) ?? { sub: "unknown", role: "employee" };
}

searchRoute.get("/", async (c) => {
  const scope = scopeOf(c);
  const term = c.req.query("q") ?? "";

  let organizationId: string | null = null;
  if (scope.role !== "operator") {
    organizationId = scope.organizationId ?? null;
    if (!organizationId) {
      logger.warn({ sub: scope.sub }, "Employee session without an organization searched");
      return c.json({ error: "Your account is not attached to a business." }, 403);
    }
  }

  const hits = await search(term, organizationId);
  return c.json({ hits, term });
});
