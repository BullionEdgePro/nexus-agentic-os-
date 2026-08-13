/**
 * The evidence gate for RLS step 4.
 *
 * Migration 018 must not be applied until the tenant-context assertion has run
 * in `strict` mode without firing — because once policies are on, a query with
 * no context stops raising and starts returning zero rows, which every caller
 * reads as "this business has no data". The architecture doc's instruction was
 * to soak strict mode against real traffic and watch. On a platform where one
 * of five businesses has customers, that soak would take weeks and still not
 * cover the paths that business never exercises.
 *
 * So this makes the evidence reproducible instead of incidental. It runs the
 * real read paths twice:
 *
 *   WRAPPED   — the way the application actually calls them, inside
 *               withTenant/withAllTenants. Nothing may fire. Anything that does
 *               is a path the middleware does not cover, and applying 018 would
 *               silently empty it.
 *
 *   UNWRAPPED — deliberately bare. Everything tenant-scoped MUST fire. If it
 *               does not, the guard is not actually watching that table, and a
 *               clean wrapped run would be meaningless — a test that cannot
 *               fail is not evidence.
 *
 * IT ALSO CHECKS THE WRITERS, and that addition was paid for.
 *
 * The first version tested reads only. Reads degrade to an empty result under
 * RLS, which is bad; writes are REJECTED outright — "new row violates
 * row-level security policy". So enabling policies silently broke every writer
 * that does not pass through the API middleware: the site crawler and the
 * half-hourly template sync both stopped writing, and the template sync's only
 * symptom would have been approvals that never arrived. Found by running the
 * crawler by hand, not by anything here — which is exactly why it is here now.
 *
 * The second half is the one worth having. It is easy to write a preflight that
 * passes because the assertion is switched off somewhere.
 *
 * Run: docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/rls-preflight.ts
 */

// Set before importing anything that reads it at module load.
process.env.DB_TENANT_ASSERT = "strict";

import {
  listOrganizations,
  withTenant,
  withAllTenants,
  getEmployeeActivity,
  getRecentActivity,
  getQualityTrend,
  getEscalationHotspots,
  listBroadcastTemplates,
  listBroadcasts,
  countReachableContacts,
  getContactMemory,
  getSharedGuidance,
  getPool,
} from "@nexus/db";
import { listKnowledgeSources } from "@nexus/knowledge";

interface Path {
  name: string;
  /** True when the path legitimately spans every business. */
  crossTenant?: boolean;
  /** True when the path touches no tenant-scoped table (registry, pooled aggregates). */
  unscoped?: boolean;
  run: (organizationId: string) => Promise<unknown>;
}

const PATHS: Path[] = [
  { name: "organizations (registry)", unscoped: true, run: () => listOrganizations() },
  { name: "shared patterns (pooled)", unscoped: true, run: () => getSharedGuidance() },

  { name: "employee activity (all)", crossTenant: true, run: () => getEmployeeActivity(null) },
  { name: "recent activity (all)", crossTenant: true, run: () => getRecentActivity(5) },

  { name: "employee activity (one)", run: (id) => getEmployeeActivity(id) },
  { name: "quality trend", run: (id) => getQualityTrend(id, 7) },
  { name: "escalation hotspots", run: (id) => getEscalationHotspots(id, 7) },
  { name: "broadcast templates", run: (id) => listBroadcastTemplates(id) },
  { name: "broadcasts", run: (id) => listBroadcasts(id) },
  { name: "reachable contacts", run: (id) => countReachableContacts(id) },
  { name: "knowledge sources", run: (id) => listKnowledgeSources(id) },
  {
    name: "contact memory",
    run: (id) => getContactMemory(id, "00000000-0000-0000-0000-000000000000"),
  },
];

const ASSERTION = /no tenant context/i;

/**
 * Code paths that WRITE tenant rows without going through the API.
 *
 * Listed by name rather than executed, because running them means crawling a
 * customer's website or calling Meta. What is checked is that each one wraps
 * its writes — the failure was never subtle logic, it was a missing wrapper.
 */
/**
 * Writers outside the API are DISCOVERED, not listed.
 *
 * This was a hand-maintained array of three files, and on 2026-08-12 that cost
 * a whole verification gate: `self-check.ts` writes an employee, a contact and
 * a lead on every run, had no tenant context, and had been aborting on "new row
 * violates row-level security policy" since the policies went on. It was not on
 * the list, because self-check is filed mentally as a checker rather than as a
 * writer — and a list only contains what somebody remembered.
 *
 * So the list is gone. Every script and service is scanned, and anything that
 * writes has to prove it establishes a context. The next writer somebody adds
 * is covered on the day it lands, without anyone remembering anything.
 */
const WRITER_DIRECTORIES = ["src/scripts", "src/services"];

/** Files whose job is to check the guard, not to run under it. */
const NOT_WRITERS = new Set(["rls-preflight.ts", "rls-verify.ts"]);

/** Raw SQL that modifies. */
const WRITES_SQL = /\b(insert\s+into|delete\s+from|update\s+\w+\s+set)\b/i;

/**
 * Writing through the db package rather than through SQL. Named prefixes rather
 * than an exhaustive list of functions, so a new `createFoo` is noticed without
 * this file being edited.
 */
const WRITES_VIA_HELPER =
  /\b(create|upsert|insert|record|reconcile|deactivate|remove|forget|purge|set)[A-Z]\w*\s*\(/;

/**
 * The tables a missing context actually breaks. Mirrors TENANT_SCOPED_TABLES in
 * packages/db/src/client.ts — the two are checked against each other by
 * schema-check, so drift shows up rather than silently narrowing this scan.
 */
const TENANT_TABLES = [
  "contacts", "conversations", "messages", "employees", "lead_assessments",
  "knowledge_sources", "knowledge_chunks", "message_templates", "broadcasts",
  "agent_configs", "ai_message_evaluations", "conversation_metrics",
  "contact_memory", "tasks", "operator_findings",
];

/**
 * WHAT THIS CAN AND CANNOT PROVE, stated because the distinction decides
 * whether a finding is a failure or a note.
 *
 * A file can write to a tenant table through a helper that establishes the
 * context itself — `provision-templates.ts` does exactly that via
 * `syncTemplatesForOrganization`. Reading one file cannot see a context living
 * one call away, so treating "writes, no context here" as a failure would fail
 * correct code and make the whole gate untrustworthy — worse than the
 * hand-maintained list it replaced.
 *
 * So: raw SQL against a tenant-scoped table with no context in the same file is
 * a FAILURE, because nothing else can be establishing it. Everything else that
 * writes is reported as delegating, for a human to confirm once.
 *
 * That distinction still catches the bug this replaced a list to catch:
 * self-check's cleanup ran `delete from contacts` directly.
 */
function writesTenantSqlDirectly(code: string): string | null {
  if (!WRITES_SQL.test(code)) return null;
  return (
    TENANT_TABLES.find((table) =>
      new RegExp(`(insert\\s+into|delete\\s+from|update)\\s+${table}\\b`, "i").test(code)
    ) ?? null
  );
}

function line(ok: boolean, label: string, detail = ""): boolean {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(30)} ${detail}`);
  return ok;
}

async function main(): Promise<void> {
  console.log("RLS preflight — strict tenant assertion\n");

  const organizations = await withAllTenants("preflight: pick a tenant", () => listOrganizations());
  const org = organizations[0];
  if (!org) {
    console.error("No active organizations. Nothing to check.");
    process.exit(1);
  }
  console.log(`Using ${org.slug}\n`);

  let allOk = true;

  // ---- wrapped: nothing may fire ----
  console.log("Wrapped as the application calls them (must be silent)");
  for (const path of PATHS) {
    try {
      if (path.unscoped) await path.run(org.id);
      else if (path.crossTenant) await withAllTenants(`preflight: ${path.name}`, () => path.run(org.id));
      else await withTenant(org.id, () => path.run(org.id));
      allOk = line(true, path.name) && allOk;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const fired = ASSERTION.test(message);
      allOk =
        line(
          false,
          path.name,
          fired ? "ASSERTION FIRED — not covered by any context" : `error: ${message.slice(0, 90)}`
        ) && allOk;
    }
  }

  // ---- unwrapped: tenant-scoped paths MUST fire ----
  console.log("\nUnwrapped on purpose (tenant-scoped paths must refuse)");
  for (const path of PATHS) {
    if (path.unscoped || path.crossTenant) continue;
    try {
      await path.run(org.id);
      // Reaching here means the guard let a tenant-scoped query through with no
      // context. After migration 018 that same query returns nothing, silently.
      allOk = line(false, path.name, "NO ASSERTION — this table is not guarded") && allOk;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      allOk = line(ASSERTION.test(message), path.name, ASSERTION.test(message) ? "refused" : message.slice(0, 90)) && allOk;
    }
  }

  // ---- writers that never touch the API middleware ----
  //
  // Checked by reading the source rather than by running them, because running
  // them means crawling a customer's website or calling Meta. The failure was
  // never subtle logic — it was a missing wrapper, and that is visible.
  console.log("\nWriters outside the API (must establish their own context)");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  let scanned = 0;
  let writers = 0;

  for (const directory of WRITER_DIRECTORIES) {
    let entries: string[];
    try {
      entries = readdirSync(join(root, directory)).filter((f) => f.endsWith(".ts"));
    } catch {
      allOk = line(false, directory, "could not be listed") && allOk;
      continue;
    }

    for (const entry of entries) {
      if (NOT_WRITERS.has(entry)) continue;
      scanned++;

      let source: string;
      try {
        source = readFileSync(join(root, directory, entry), "utf8");
      } catch {
        allOk = line(false, entry, "could not be read") && allOk;
        continue;
      }

      // Comments AND imports stripped first. Comments because this repo
      // discusses writes at length in prose; imports because `@nexus/employees`
      // is a package whose name is also a tenant table, and matching it made
      // create-admin.ts — which touches only the admin registry — look like it
      // wrote customer data.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ")
        .replace(/^\s*import[\s\S]*?from\s+["'][^"']+["'];?/gm, " ");

      if (!WRITES_SQL.test(code) && !WRITES_VIA_HELPER.test(code)) continue;

      writers++;
      const wrapped = /withTenant\(|withAllTenants\(/.test(code);
      const directTable = writesTenantSqlDirectly(code);

      if (wrapped) {
        line(true, entry, "");
      } else if (directTable) {
        // Provable: raw SQL against a tenant table, no context in this file,
        // nothing else that could be establishing one.
        allOk = line(false, entry, `NO CONTEXT — writes ${directTable} directly, REJECTED`) && allOk;
      } else {
        // Writes only through helpers. The context may legitimately live in the
        // callee, which reading one file cannot see. Reported, not failed.
        line(true, entry, "delegates its writes — confirm the callee scopes them");
      }
    }
  }

  // Printed because a discovery pass that silently finds nothing looks exactly
  // like a discovery pass that found everything in order.
  console.log(`  —     ${writers} writer(s) found among ${scanned} scanned file(s)`);

  console.log(
    allOk
      ? "\nPASS — every application path carries a context, every unguarded call is refused," +
          "\nand every writer outside the API establishes its own.\n"
      : "\nFAIL — do NOT apply migration 018, and if it is already applied, fix these now." +
          "\nUnscoped reads return zero rows; unscoped WRITES are rejected outright.\n"
  );

  // ============================================================
  // Unauthenticated routes must carry their own context
  // ============================================================
  //
  // The gap this closes, stated plainly: everything above walks a
  // hand-maintained list of thirteen application paths, so it can only ever
  // confirm what somebody remembered to add. `findEmployeeForLogin` was never
  // on it. This gate reported PASS on every run while employee sign-in was
  // broken for every employee in production, because the one query that
  // mattered was not a path it knew about.
  //
  // Most functions in packages/db are RIGHT to be unwrapped — they inherit the
  // caller's withTenant, and that is the normal pattern. The exception is the
  // handful reachable from /auth/*, which runs before any session exists. There
  // no caller can establish a context, so the function has to establish its
  // own or silently read zero rows forever.
  //
  // Derived from the imports of the auth routes rather than listed here, so a
  // new helper added to a sign-in path is covered the day it is written.
  console.log("\nUnauthenticated routes (must establish their own context)");
  {
    const AUTH_ROUTES = ["employee-auth.ts", "admin-auth.ts"];
    const dbSource = readdirSync(join(root, "..", "..", "packages", "db", "src"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => readFileSync(join(root, "..", "..", "packages", "db", "src", f), "utf8"))
      .join("\n");

    let checked = 0;
    for (const routeFile of AUTH_ROUTES) {
      let route: string;
      try {
        route = readFileSync(join(root, "src", "routes", routeFile), "utf8");
      } catch {
        allOk = line(false, routeFile, "MISSING — an auth route vanished, or was renamed") && allOk;
        continue;
      }

      // import { findEmployeeForLogin, recordEmployeeLogin } from "@nexus/db";
      const imported = [...route.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']@nexus\/db["']/g)]
        .flatMap((m) => m[1].split(","))
        .map((name) => name.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);

      for (const fn of imported) {
        // Slice the function's own body out of the package source.
        const start = dbSource.search(new RegExp(`export\\s+(?:async\\s+)?function\\s+${fn}\\b`));
        if (start === -1) {
          allOk = line(false, `${routeFile} → ${fn}`, "NOT FOUND in packages/db") && allOk;
          continue;
        }
        const rest = dbSource.slice(start);
        const next = rest.slice(1).search(/\nexport\s+(?:async\s+)?function\s/);
        const body = next === -1 ? rest : rest.slice(0, next + 1);

        const touchesTenantTable = TENANT_TABLES.some((table) =>
          new RegExp(`(^|[^a-z0-9_])${table}([^a-z0-9_]|$)`, "i").test(body)
        );
        if (!touchesTenantTable) continue;

        checked++;
        const establishes = /withTenant\(|withAllTenants\(/.test(body);
        allOk =
          line(
            establishes,
            `${routeFile} → ${fn}`,
            establishes
              ? "establishes its own context"
              : "NO CONTEXT — runs before any session exists, so RLS returns zero rows and sign-in fails as 'wrong code'"
          ) && allOk;
      }
    }
    if (checked === 0) {
      allOk = line(false, "auth-route coverage", "checked nothing — the import scan matched no db calls") && allOk;
    }
  }

  await getPool().end();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
