import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";

/**
 * Which tenant the current unit of work belongs to.
 *
 * This is step 3 of the RLS sequence in ARCHITECTURE-ABOS.md §2.2, and it
 * exists to be in front of step 4 rather than beside it. The danger of Row-Level
 * Security is not that a policy rejects a query — it is that a policy with no
 * tenant context returns **zero rows and no error**, which every caller here
 * would read as "this business has no conversations". A silent empty result is
 * the worst failure this codebase can produce, so the context has to be
 * asserted in application code, loudly, before the database is ever asked.
 *
 * Two legitimate shapes, both named rather than implied:
 *
 *   tenant — one business. The normal case.
 *   all    — deliberately across every business, with a stated reason. The
 *            operator inbox shows all five, and the inbound worker must resolve
 *            phone_number_id → organization *before* it knows which tenant it
 *            is serving. Both are real; neither is an accident; so both say so.
 *
 * The reason string on `all` is not decoration. A cross-tenant query is exactly
 * what RLS is meant to prevent, so every one of them should be readable in the
 * code and greppable in the logs.
 */
export type TenantContext =
  | { scope: "tenant"; organizationId: string; client: PoolClient }
  | { scope: "all"; reason: string; client: PoolClient };

const storage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext | undefined {
  return storage.getStore();
}

/** For logs and error messages — never for authorisation decisions. */
export function describeTenantContext(): string {
  const context = storage.getStore();
  if (!context) return "none";
  return context.scope === "tenant" ? `tenant:${context.organizationId}` : `all:${context.reason}`;
}

export function runWithContext<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(context, fn);
}
