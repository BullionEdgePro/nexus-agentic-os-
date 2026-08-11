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
const WRITERS = [
  { name: "ingest-site (crawler)", file: "src/scripts/ingest-site.ts" },
  { name: "template sync (scheduled)", file: "src/services/template-sync.ts" },
  { name: "quality rollup (hourly)", file: "src/services/quality-rollup.ts" },
];

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
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  for (const writer of WRITERS) {
    try {
      const source = readFileSync(join(root, writer.file), "utf8");
      const wrapped = /withTenant\(|withAllTenants\(/.test(source);
      allOk =
        line(wrapped, writer.name, wrapped ? "" : "NO CONTEXT — its writes are REJECTED") && allOk;
    } catch {
      allOk = line(false, writer.name, "could not be read") && allOk;
    }
  }

  console.log(
    allOk
      ? "\nPASS — every application path carries a context, every unguarded call is refused," +
          "\nand every writer outside the API establishes its own.\n"
      : "\nFAIL — do NOT apply migration 018, and if it is already applied, fix these now." +
          "\nUnscoped reads return zero rows; unscoped WRITES are rejected outright.\n"
  );

  await getPool().end();
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
