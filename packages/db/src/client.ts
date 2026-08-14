import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import {
  getTenantContext,
  runWithContext,
  runWithoutContext,
  describeTenantContext,
} from "./tenant-context.js";

let pool: Pool | undefined;

function rawPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

/**
 * Tables whose rows belong to one business.
 *
 * A query touching any of these outside a tenant context is a bug — either a
 * forgotten `withTenant`, or the very "forgotten WHERE clause" that Row-Level
 * Security exists to catch. Listed explicitly rather than derived, because the
 * cost of a wrong entry differs by direction: a table missing from this list
 * loses its assertion silently, while a table wrongly on it fails loudly the
 * first time it is queried, with a message naming the fix.
 */
const TENANT_SCOPED_TABLES = [
  "contacts",
  "conversations",
  "messages",
  "employees",
  "lead_assessments",
  "knowledge_sources",
  "knowledge_chunks",
  "message_templates",
  "broadcasts",
  "agent_configs",
  "ai_message_evaluations",
  "conversation_metrics",
  "contact_memory",
  "tasks",
  "operator_findings",
  "bookings",
];
// Not on the list, and each for a reason worth stating:
//
//   organizations, admins      — the tenant registry and the people who
//                                administer it. Scoping the registry to a
//                                tenant is circular: the lookup that resolves
//                                which tenant we are is the one that would need
//                                the answer.
//   broadcast_recipients       — has no organization_id. It is reached only
//                                through a broadcast, which is scoped, so the
//                                policy on the parent is what protects it.
//   routing_keywords           — not a table at all. It is a column on
//                                organizations, and listing it here made the
//                                shared-number lookup look tenant-scoped when
//                                it is the query that determines the tenant.

/**
 * Strips comments and string literals before looking for table names.
 *
 * Without this, a query whose *comment* mentions "messages", or one inserting
 * the literal text 'contacts', would be treated as tenant-scoped and throw. The
 * assertion has to be about what the query touches, not what it says.
 */
function scrubSql(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, " '' ")
    .toLowerCase();
}

function tenantScopedTableIn(sql: string): string | undefined {
  const scrubbed = scrubSql(sql);
  return TENANT_SCOPED_TABLES.find((table) =>
    // Word-bounded: "messages" must not match "message_templates", and
    // "broadcasts" must not match "broadcast_recipients".
    new RegExp(`(^|[^a-z0-9_])${table}([^a-z0-9_]|$)`).test(scrubbed)
  );
}

/**
 * How hard a missing tenant context fails.
 *
 * `strict` throws — correct once every path has been converted, and required
 * before RLS policies are enabled, since after that the same query returns an
 * empty result instead of an error.
 *
 * `warn` logs and proceeds. This is the default *only* while paths are being
 * migrated: turning the assertion on everywhere at once, in a system currently
 * answering real customers on WhatsApp, would trade a latent bug for an
 * immediate outage.
 */
function assertMode(): "strict" | "warn" | "off" {
  const configured = process.env.DB_TENANT_ASSERT;
  if (configured === "strict" || configured === "warn" || configured === "off") return configured;
  return "warn";
}

function assertContext(sql: string): void {
  if (getTenantContext()) return;

  const mode = assertMode();
  if (mode === "off") return;

  const table = tenantScopedTableIn(sql);
  if (!table) return;

  const message =
    `Query touched tenant-scoped table "${table}" with no tenant context. ` +
    `Wrap it in withTenant(organizationId, ...) — or, if it is deliberately ` +
    `cross-tenant, in withAllTenants("why", ...). ` +
    `Once RLS is enabled this query returns zero rows instead of an error.`;

  if (mode === "strict") throw new Error(message);
  // eslint-disable-next-line no-console
  console.warn(`[db] ${message}\n      ${sql.slice(0, 160).replace(/\s+/g, " ")}`);
}

export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<R>>;
  end(): Promise<void>;
}

/**
 * The database handle every query in this package goes through.
 *
 * Deliberately not a `Pool`. When a tenant context is active it holds a checked
 * out client inside an open transaction — `SET LOCAL app.current_org` applies
 * only to that connection and only until the transaction ends — so queries must
 * land on *that* client rather than on whichever one the pool hands out next.
 * Routing here rather than at the call sites means the fifty-odd existing
 * queries gained tenant scoping without being rewritten, and a new one cannot
 * forget to opt in.
 */
export function getPool(): Queryable {
  return {
    query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) {
      const context = getTenantContext();
      if (context) return context.client.query<R>(sql, params);
      assertContext(sql);
      return rawPool().query<R>(sql, params);
    },
    end() {
      return pool ? pool.end() : Promise.resolve();
    },
  };
}

async function withClient<T>(
  setup: (client: PoolClient) => Promise<void>,
  makeContext: (client: PoolClient) => Parameters<typeof runWithContext>[0],
  fn: () => Promise<T>
): Promise<T> {
  const existing = getTenantContext();
  // Nesting would open a transaction inside a transaction and, worse, let an
  // inner "all" scope silently widen an outer tenant scope. Reusing the
  // existing context keeps the outermost decision authoritative.
  if (existing) return fn();

  const client = await rawPool().connect();
  try {
    await client.query("begin");
    await setup(client);
    const result = await runWithContext(makeContext(client), fn);
    await client.query("commit");
    return result;
  } catch (err) {
    // Rolling back is best-effort: if the connection itself died, the rollback
    // fails too, and throwing that would replace the real cause with a
    // secondary one.
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Runs `fn` scoped to one business.
 *
 * Everything inside — including code that only calls `getPool().query` and
 * knows nothing about tenancy — runs on a connection where `app.current_org` is
 * set, inside one transaction. That makes the unit of work atomic as well as
 * scoped, which is the behaviour you want anyway: a lead written but its
 * conversation not is worse than neither.
 */
export function withTenant<T>(organizationId: string, fn: () => Promise<T>): Promise<T> {
  if (!organizationId) {
    // An empty id would set the context to the empty string, which every policy
    // reads as "matches nothing" — the silent-empty-result failure again, one
    // layer up.
    throw new Error("withTenant requires an organizationId");
  }
  return withClient(
    (client) => client.query("select set_config('app.current_org', $1, true)", [organizationId]).then(() => undefined),
    (client) => ({ scope: "tenant", organizationId, client }),
    fn
  );
}

/**
 * Runs `fn` across every business, on purpose.
 *
 * The `reason` is required and appears in logs. Two paths legitimately need
 * this — the operator inbox, which is meant to show all five businesses, and
 * the inbound worker, which cannot know the tenant until it has looked up which
 * phone number the message arrived on. Anything else calling this is worth a
 * second look, which is exactly why it has to name itself.
 */
export function withAllTenants<T>(reason: string, fn: () => Promise<T>): Promise<T> {
  if (!reason) throw new Error("withAllTenants requires a reason");
  return withClient(
    (client) => client.query("select set_config('app.tenant_scope', 'all', true)").then(() => undefined),
    (client) => ({ scope: "all", reason, client }),
    fn
  );
}

/**
 * Runs `fn` for ANOTHER business served by the same WhatsApp number, on the
 * transaction that is already open.
 *
 * THE HOLE THIS FILLS, AND IT IS NOT A SMALL ONE.
 *
 * Migration 010 put all five businesses on Zipicka's number. Every inbound
 * message therefore belongs to Zipicka — the number's owner — and the reply
 * pipeline opens `withTenant(owner.id)` around the whole job. But the
 * switchboard then decides the enquiry is for, say, Juris Prime, and everything
 * after that point is asked about the SERVING business: its staff, its
 * follow-ups, its memory of this customer, and now its bookings.
 *
 * Those reads were being made inside the owner's context. RLS matched no rows.
 * Nothing threw, because a policy that filters everything out returns an empty
 * result, and `withTenant` nested inside `withTenant` deliberately reuses the
 * outer context rather than opening a second one — so `withTenant(serving.id,
 * ...)` at those call sites was a no-op that read exactly like a fix.
 *
 * The two ways out that do not work:
 *
 *   A second connection (`withoutTenant` then `withTenant`) opens a separate
 *   transaction. The conversation and contact rows this job just wrote are not
 *   committed yet, so a booking referencing them fails on a foreign key — on
 *   first-message bookings only, which is the subset nobody would test.
 *
 *   Widening the policy so the number's owner can see what it serves puts the
 *   check on every row of every read, and hands the retailer standing access to
 *   the law firm's customer commitments. The relationship is real for one
 *   statement; it should not become a permanent grant.
 *
 * So the context is switched on the connection already in hand — same
 * transaction, same snapshot, restored in a `finally` — and the switch is
 * refused unless the two businesses genuinely share a number. That last part is
 * what keeps this from being a general-purpose way out of RLS: the argument is
 * checked against the data, not taken on trust, so it can only reach a business
 * the caller is already answering the phone for.
 */
export async function withServingTenant<T>(
  organizationId: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!organizationId) throw new Error("withServingTenant requires an organizationId");

  const context = getTenantContext();
  // No ambient scope: this is an ordinary scoped unit of work and opens its own
  // transaction. Degrading to `withTenant` rather than throwing is what makes
  // this a safe drop-in at call sites reached from both inside and outside the
  // message pipeline — `hasStaffOnShift` is called three times from within the
  // owner's transaction and once from a fallback path that has none, and a
  // version that threw would turn a correct call into an outage on the path
  // that matters most.
  if (!context) return withTenant(organizationId, fn);
  // Already cross-tenant on purpose (the operator deck, the inbound worker
  // before it knows the tenant). Nothing to widen.
  if (context.scope === "all") return fn();
  if (context.organizationId === organizationId) return fn();

  const client = context.client;
  const { rows } = await client.query<{ shared: boolean }>(
    `select exists (
       select 1
         from organizations owner, organizations serving
        where owner.id = $1
          and serving.id = $2
          and serving.is_active
          and owner.whatsapp_phone_number_id is not null
          and owner.whatsapp_phone_number_id <> ''
          and owner.whatsapp_phone_number_id = serving.whatsapp_phone_number_id
     ) as shared`,
    [context.organizationId, organizationId]
  );
  if (!rows[0]?.shared) {
    throw new Error(
      `Refusing to widen tenant scope from ${context.organizationId} to ${organizationId}: ` +
        "those businesses do not share a WhatsApp number, so one is not serving the other's callers."
    );
  }

  const restore = context.organizationId;
  try {
    await client.query("select set_config('app.current_org', $1, true)", [organizationId]);
    return await runWithContext({ scope: "tenant", organizationId, client }, fn);
  } finally {
    // Restored even on the throw path. Leaving the connection pointed at the
    // serving business would silently re-scope the REST of the owner's
    // transaction — the outbound message, the evaluation, the metric — and
    // those writes would fail the policy one by one with no obvious cause.
    await client.query("select set_config('app.current_org', $1, true)", [restore]);
  }
}

/**
 * Runs `fn` with NO tenant context, on a pool connection like any unauthenticated
 * caller gets.
 *
 * This exists for verification, not for feature code. A gate that exercises a
 * sign-in path from inside `withTenant(...)` proves nothing about that path: the
 * ambient context makes an unscoped query succeed for the probe and return zero
 * rows for the real HTTP route, which has no context to inherit. `self-check`
 * asserted "sign-in lookup by email" and passed, every run, while employee
 * sign-in was broken in production for every employee — because the check ran
 * somewhere the caller never stands.
 *
 * So: use this to assert that something works for a caller who has proven
 * nothing yet. Never to escape a scope you are supposed to be inside.
 */
export function withoutTenant<T>(fn: () => Promise<T>): Promise<T> {
  return runWithoutContext(fn);
}

export { getTenantContext, describeTenantContext };
