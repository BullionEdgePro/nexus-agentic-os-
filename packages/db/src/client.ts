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
/**
 * EXPORTED SINCE 2026-08-19, because it was being copied instead.
 *
 * `rls-preflight` kept its own transcription of this array and said so in a
 * comment: "the two are checked against each other by schema-check, so drift
 * shows up rather than silently narrowing this scan". Nothing compared them.
 * The copy was six tables short -- bookings, forecasts, procedures,
 * agent_phrases, catalog_installs, reengagement_attempts -- so the gate that
 * scans for raw SQL against tenant tables with no context could not see any of
 * them. The comment named the exact failure it was there to rule out.
 */
export const TENANT_SCOPED_TABLES = [
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
  "procedures",
  "reengagement_attempts",
  "catalog_installs",
  "agent_phrases",
  "tasks",
  "operator_findings",
  "bookings",
  "forecasts",
  // Migration 064. Both carry organization_id and both are read on a path a
  // business reaches, so rls-verify's derived catalogue would have failed on
  // them the moment they existed -- it lists every table with that column and
  // no row-level security, precisely so a new one cannot be forgotten here.
  "automations",
  "automation_runs",
  // Added 2026-08-25 with calendar presence. Both carry an organization_id
  // and both are read on the reply path, so an unscoped query here would be
  // the shared-number trap by a new door.
  "employee_calendars",
  "calendar_busy",
  // Added 2026-08-25 with lead labels. Carries an organization_id and is
  // read per business, so it belongs on this list like everything else.
  "lead_labels",
  // Added 2026-08-25 with the editable system prompt. Carries an
  // organization_id and holds the previous text of what the agent was told
  // to be, which is that business's alone.
  "agent_config_versions",
  // Added 2026-08-19. Each carries an organization_id, so each is tenant data
  // by construction, and none was on this list, on migration 018's array, or on
  // rls-verify's copy — the three places the set is typed out. A table is
  // protected only if it appears in all three, and these appeared in none.
  //
  // `agent_quality_daily` held 195 rows across all five businesses that way.
  // The other three are empty; `employee_presence_events` and `twin_handbacks`
  // have writers and no readers, `organization_users` is referenced by no code
  // at all. Listed anyway, because "empty today" is not a property.
  //
  // Found by building the repository's own schema in a throwaway database and
  // diffing it against production, which is now `schema-drift-check.sh`.
  "agent_quality_daily",
  "employee_presence_events",
  "organization_users",
  "twin_handbacks",
  // Added 2026-09-28 with customer lists (migration 093). A business's saved
  // audiences are its own; read under its tenant, or across all on purpose.
  "contact_segments",
  // Business HQ (migration 097, 14 Oct 2026). The vault holds every login of a
  // business; an unwrapped query on it must throw, not silently read nothing.
  "hq_profiles",
  "hq_keywords",
  "hq_social_accounts",
  "hq_vault_entries",
  "hq_vault_reveals",
  "hq_checks",
  // Org charts (migration 098).
  "hq_org_members",
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
//   catalog_items              — the marketplace catalogue. A shared registry
//                                every business reads, like organizations.
//                                Scoping it to one tenant would be circular,
//                                and it holds no tenant data by construction:
//                                it has no organization_id and no foreign key
//                                to any tenant table, which is what makes
//                                "nothing leaves" a property rather than a rule.
//                                `catalog_installs` IS scoped — which packs a
//                                business chose is that business's business.
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
      if (context) return noted(context.client, sql, context.client.query<R>(sql, params));
      assertContext(sql);
      return rawPool().query<R>(sql, params);
    },
    end() {
      return pool ? pool.end() : Promise.resolve();
    },
  };
}

/**
 * What an open transaction has done, so its commit can say what was lost.
 *
 * A FAILED STATEMENT ABORTS THE WHOLE TRANSACTION (3 Nov 2026). Postgres then
 * refuses every later statement (25P02) and answers the commit with ROLLBACK
 * rather than an error -- so code that caught the first failure and carried on
 * lost everything it had written, and the request still answered 200. A quick
 * send reported "sent" with no message recorded; a scheduled message went out
 * again every minute.
 */
interface TransactionHealth {
  /** A write succeeded -- and is undone if the commit comes back ROLLBACK. */
  wrote: boolean;
  /** A write was refused because of an earlier failure. */
  refusedWrite: boolean;
  /** The first failure that was not a refusal: the cause. */
  failure: unknown;
}

const health = new WeakMap<PoolClient, TransactionHealth>();
const WRITE_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE", "MERGE"]);
const IN_FAILED_TRANSACTION = "25P02";

/** For a refused statement only, which has no result to say what it was. */
function isWriteStatement(sql: string): boolean {
  const scrubbed = scrubSql(sql).replace(/\bfor\s+(no\s+key\s+)?update\b/g, " ");
  return /\b(insert\s+into|update\s+["a-z_]|delete\s+from|merge\s+into)\b/.test(scrubbed);
}

function noted<R extends QueryResultRow>(
  client: PoolClient,
  sql: string,
  query: Promise<QueryResult<R>>
): Promise<QueryResult<R>> {
  const record = health.get(client);
  if (!record) return query;
  return query.then(
    (result) => {
      if (WRITE_COMMANDS.has(result.command)) record.wrote = true;
      return result;
    },
    (err: unknown) => {
      if ((err as { code?: string } | null)?.code === IN_FAILED_TRANSACTION) {
        if (isWriteStatement(sql)) record.refusedWrite = true;
      } else if (record.failure === undefined) {
        record.failure = err;
      }
      throw err;
    }
  );
}

const LOST_WRITES =
  "Nothing in this piece of work was saved: a database statement failed, its error was caught, and Postgres then rolled the whole transaction back.";

/** A commit that came back ROLLBACK after writes: they are gone. `cause` is the failure that was caught. */
export class TransactionRolledBack extends Error {
  constructor(cause: unknown) {
    super(LOST_WRITES, { cause });
    this.name = "TransactionRolledBack";
  }
}

export interface TransactionOptions {
  /**
   * Throw TransactionRolledBack when a commit lost writes, instead of logging
   * it. The request middleware asks for this: somebody is waiting for an
   * answer. A job does not -- a retry would repeat whatever it already did
   * outside the database, such as answering a customer.
   */
  failOnLostWrites?: boolean;
}

async function withClient<T>(
  setup: (client: PoolClient) => Promise<void>,
  makeContext: (client: PoolClient) => Parameters<typeof runWithContext>[0],
  fn: () => Promise<T>,
  options: TransactionOptions = {}
): Promise<T> {
  const existing = getTenantContext();
  // Nesting would open a transaction inside a transaction and, worse, let an
  // inner "all" scope silently widen an outer tenant scope. Reusing the
  // existing context keeps the outermost decision authoritative.
  if (existing) return fn();

  const client = await rawPool().connect();
  const record: TransactionHealth = { wrote: false, refusedWrite: false, failure: undefined };
  try {
    await client.query("begin");
    await setup(client);
    health.set(client, record);
    const result = await runWithContext(makeContext(client), fn);
    const done = await client.query("commit");
    if (done.command === "ROLLBACK") {
      if (record.wrote || record.refusedWrite) {
        if (options.failOnLostWrites) throw new TransactionRolledBack(record.failure);
        // eslint-disable-next-line no-console
        console.error(`[db] ${LOST_WRITES}`, record.failure);
      } else {
        // eslint-disable-next-line no-console
        console.warn("[db] A read-only transaction rolled back after a caught failure:", record.failure);
      }
    }
    return result;
  } catch (err) {
    // Rolling back is best-effort: if the connection itself died, the rollback
    // fails too, and throwing that would replace the real cause with a
    // secondary one.
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    health.delete(client);
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
export function withTenant<T>(organizationId: string, fn: () => Promise<T>, options?: TransactionOptions): Promise<T> {
  if (!organizationId) {
    // An empty id would set the context to the empty string, which every policy
    // reads as "matches nothing" — the silent-empty-result failure again, one
    // layer up.
    throw new Error("withTenant requires an organizationId");
  }
  return withClient(
    (client) => client.query("select set_config('app.current_org', $1, true)", [organizationId]).then(() => undefined),
    (client) => ({ scope: "tenant", organizationId, client }),
    fn,
    options
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
export function withAllTenants<T>(reason: string, fn: () => Promise<T>, options?: TransactionOptions): Promise<T> {
  if (!reason) throw new Error("withAllTenants requires a reason");
  return withClient(
    (client) => client.query("select set_config('app.tenant_scope', 'all', true)").then(() => undefined),
    (client) => ({ scope: "all", reason, client }),
    fn,
    options
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
  let failed = false;
  try {
    await client.query("select set_config('app.current_org', $1, true)", [organizationId]);
    return await runWithContext({ scope: "tenant", organizationId, client }, fn);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // Restored even on the throw path. Leaving the connection pointed at the
    // serving business would silently re-scope the REST of the owner's
    // transaction — the outbound message, the evaluation, the metric — and
    // those writes would fail the policy one by one with no obvious cause.
    await restoreCurrentOrg(client, restore, failed);
  }
}

let savepoints = 0;

/**
 * Runs `fn` atomically INSIDE the transaction that is already open: between a
 * savepoint and its release, rolled back to the savepoint if `fn` fails.
 *
 * WHY NOT begin/commit (3 Nov 2026). Inside a context, getPool() is the
 * request's own connection, so a function's own `begin` does nothing and its
 * `commit` ends the REQUEST's transaction early -- dropping its `set local`
 * tenant settings, so every later query in the request ran with no tenant and
 * read nothing. That is how saving the agent's prompt answered "could not be
 * read back" after it had saved. A savepoint keeps the work atomic and the
 * caller's transaction, tenant and all, exactly as it was.
 *
 * Refuses to run without a context: there is no transaction to be part of, and
 * getPool() would spread the statements over different pooled connections.
 */
export async function withSavepoint<T>(fn: () => Promise<T>): Promise<T> {
  const context = getTenantContext();
  if (!context) {
    throw new Error("withSavepoint runs inside the transaction a tenant context opens, and there is no context here.");
  }
  const name = `nexus_savepoint_${++savepoints}`;
  await context.client.query(`savepoint ${name}`);
  // Taken once the savepoint is set, so the transaction was healthy here.
  const record = health.get(context.client);
  const before = record ? { ...record } : undefined;
  try {
    const result = await fn();
    await context.client.query(`release savepoint ${name}`);
    return result;
  } catch (err) {
    const revived = await context.client.query(`rollback to savepoint ${name}`).then(
      () => true,
      () => false
    );
    // Healthy again, and what it undid was undone on purpose: neither the
    // failure nor those writes are anything the commit lost (3 Nov 2026).
    if (revived && record && before) Object.assign(record, before);
    throw err;
  }
}

/**
 * Runs `fn` so that its failure cannot abort the caller's transaction: in its
 * own savepoint inside one, and as it is outside one, where each statement is
 * already its own transaction. For a step that may run either way -- a booking
 * made by the AI's tool inside a reply, or by a script with no context.
 */
export function isolated<T>(fn: () => Promise<T>): Promise<T> {
  return getTenantContext() ? withSavepoint(fn) : fn();
}

/**
 * Points the connection back at the business it was scoped to before a switch.
 * When the switched work has already failed with a database error, the
 * transaction is aborted and this cannot run -- and its own "current
 * transaction is aborted" must not replace the cause in the logs and in the
 * error a person sees (final review, 3 Nov 2026). The transaction is rolled
 * back either way, so nothing is left pointed anywhere.
 */
async function restoreCurrentOrg(client: PoolClient, organizationId: string, afterFailure: boolean): Promise<void> {
  try {
    await client.query("select set_config('app.current_org', $1, true)", [organizationId]);
  } catch (err) {
    if (!afterFailure) throw err;
  }
}

/**
 * Runs `fn` as the OWNER of a contact this business serves, on the transaction
 * already open -- the mirror of `withServingTenant`, for a handful of writes
 * that are facts about the person rather than about the business: an email
 * opt-out, a bounce, a platform sender, the best lead score they have reached.
 *
 * WHY IT EXISTS (2 Nov 2026). The email sweep runs inside
 * `withTenant(<the mailbox's business>)`, and the customer who replied "stop"
 * may be a shared contact the number's owner owns and this business serves.
 * Migration 106 made such rows owner-only for UPDATE, so those writes affected
 * zero rows -- silently, where before 106 they failed loudly -- and
 * `withAllTenants` cannot help: nested inside a tenant it deliberately reuses
 * the outer scope.
 *
 * THE SWITCH IS CHECKED AGAINST THE DATA, as `withServingTenant`'s is: only when
 * the current business is in the contact's `served_organization_ids`, so it
 * reaches no person this business is not genuinely serving. Anywhere else --
 * no ambient tenant, a cross-tenant context, the owner itself, a contact it
 * does not serve -- `fn` runs exactly as it would have.
 */
export async function withContactOwner<T>(contactId: string, fn: () => Promise<T>): Promise<T> {
  const context = getTenantContext();
  if (!context || context.scope === "all") return fn();

  const client = context.client;
  const { rows } = await client.query<{ owner: string }>(
    `select organization_id as owner from contacts
      where id = $1 and $2::uuid = any (served_organization_ids)`,
    [contactId, context.organizationId]
  );
  const ownerId = rows[0]?.owner;
  if (!ownerId || ownerId === context.organizationId) return fn();

  const restore = context.organizationId;
  let failed = false;
  try {
    await client.query("select set_config('app.current_org', $1, true)", [ownerId]);
    return await runWithContext({ scope: "tenant", organizationId: ownerId, client }, fn);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    // Restored even on the throw path, so the rest of the sweep stays scoped
    // to the mailbox's own business.
    await restoreCurrentOrg(client, restore, failed);
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
