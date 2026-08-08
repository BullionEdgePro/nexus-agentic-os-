import type { SessionScope } from "../lib/session.js";

/**
 * What `requireAuth` puts on the request context.
 *
 * Declared once so `c.get("scope")` is typed everywhere rather than cast at
 * each call site. A cast would compile just as happily against a context where
 * nothing set the value — and a scope check that silently reads `undefined` is
 * a scope check that passes.
 */
declare module "hono" {
  interface ContextVariableMap {
    /** Who this request is acting as, and which business they may reach. */
    scope: SessionScope;
    /** Subject of the session, kept for log correlation. */
    operator: string;
  }
}
