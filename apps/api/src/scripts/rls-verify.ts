/**
 * Does Row-Level Security actually enforce anything?
 *
 * `rls-preflight.ts` runs BEFORE the policies and answers "is it safe to apply
 * them". This runs AFTER and answers the different, harder question: are they
 * doing anything at all.
 *
 * The trap it exists for is written into the architecture doc's own history —
 * "App as Postgres superuser: RLS would deploy and enforce nothing". A
 * superuser, and a table's owner, bypass every policy unconditionally. Install
 * policies while the application connects as either, and `pg_policies` fills up,
 * the migration reports success, the tables say `rowsecurity = true`, and one
 * tenant can still read another's customers. Nothing anywhere says otherwise.
 *
 * So this checks, as the application's own role:
 *
 *   1. WHO AM I — superuser? table owner? `rolbypassrls`? Any of those and
 *      everything below is theatre, so it is checked first and fails loudly.
 *   2. ARE POLICIES ON — per table, from the catalog rather than from the
 *      migration having run without error.
 *   3. DO THEY FILTER — inside one business's context, count another business's
 *      rows. Must be zero. This is the only check that proves enforcement
 *      rather than installation.
 *   4. DO THEY LET REAL WORK THROUGH — a tenant read must still return that
 *      tenant's own rows. A policy that blocks everything is "secure" and
 *      useless, and is exactly what a wrong policy looks like.
 *
 * Run after applying migration 018:
 *   docker exec -w /app/apps/api nexus-api-1 npx tsx src/scripts/rls-verify.ts
 */

import {
  listOrganizations,
  withTenant,
  withAllTenants,
  getPool,
  TENANT_SCOPED_TABLES,
} from "@nexus/db";

/**
 * THE LIST ITSELF, not a third transcription of it.
 *
 * This gate had its own copy, `rls-preflight` had another, and migration 018
 * had a fourth as a SQL array. A table was protected only if it appeared in all
 * of them, which on 2026-08-19 four tables did not. Two of the copies are now
 * this import; 018's array is history and cannot be changed, which is why
 * migration 052 derives its set from the schema rather than adding a fifth.
 */
const TABLES = TENANT_SCOPED_TABLES;

let failures = 0;

function line(ok: boolean, label: string, detail = ""): void {
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(34)} ${detail}`);
}

async function main(): Promise<void> {
  console.log("RLS verify — are the policies actually enforcing?\n");

  // ---- 1. who the application is ----
  console.log("Identity");
  const { rows: who } = await withAllTenants("rls-verify: identity", () =>
    getPool().query<{
      current_user: string;
      is_super: boolean;
      bypasses: boolean;
      owned: string;
    }>(
      `select current_user,
              (select rolsuper      from pg_roles where rolname = current_user) as is_super,
              (select rolbypassrls  from pg_roles where rolname = current_user) as bypasses,
              (select count(*)::text from pg_tables
                where schemaname = 'public' and tableowner = current_user)      as owned`
    )
  );
  const identity = who[0];
  console.log(`  connected as ${identity.current_user}`);
  line(!identity.is_super, "not a superuser", identity.is_super ? "SUPERUSERS BYPASS ALL POLICIES" : "");
  line(!identity.bypasses, "no rolbypassrls", identity.bypasses ? "this role bypasses RLS by grant" : "");
  line(
    Number(identity.owned) === 0,
    "owns no tables",
    Number(identity.owned) > 0
      ? `owns ${identity.owned} — an owner bypasses its own policies`
      : ""
  );

  if (identity.is_super || identity.bypasses || Number(identity.owned) > 0) {
    console.log(
      "\nSTOP — the application role bypasses RLS. Policies below may exist and" +
        "\nenforce nothing. Fix APP_DB_USER before trusting any of this.\n"
    );
    await getPool().end();
    process.exit(1);
  }

  // ---- 2. are policies on ----
  console.log("\nPolicies enabled");
  const { rows: enabled } = await withAllTenants("rls-verify: catalog", () =>
    getPool().query<{ tbl: string; rls: boolean; policies: string }>(
      `select c.relname as tbl,
              c.relrowsecurity as rls,
              (select count(*)::text from pg_policies p
                where p.schemaname = 'public' and p.tablename = c.relname) as policies
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = any($1::text[])`,
      [TABLES]
    )
  );
  for (const row of enabled) {
    line(row.rls && Number(row.policies) > 0, row.tbl, row.rls ? `${row.policies} policies` : "RLS OFF");
  }
  const missing = TABLES.filter((t) => !enabled.some((r) => r.tbl === t));
  for (const t of missing) line(false, t, "table not found in catalog");

  // ---- 2b. the tables NOBODY listed ----
  //
  // Everything above checks the list. This checks the database, and it is the
  // only part of this gate that can find a table nobody thought of.
  //
  // The set is typed out in three places — migration 018's array,
  // TENANT_SCOPED_TABLES in client.ts, and the TABLES above — and a table is
  // protected only if it is in all three. On 2026-08-19 four were in none:
  // agent_quality_daily (195 rows across all five businesses),
  // employee_presence_events, organization_users and twin_handbacks. This gate
  // reported PASS the whole time, correctly, about the tables it had been told
  // about.
  //
  // Derived from the schema instead: any table carrying an organization_id is
  // tenant data by construction. The exclusions client.ts documents
  // (organizations, admins, catalog_items, broadcast_recipients) have no such
  // column, so they do not appear here and need no special case.
  console.log("\nTenant tables nobody listed");
  const { rows: unlisted } = await withAllTenants("rls-verify: derived catalog", () =>
    getPool().query<{ tbl: string }>(
      `select c.relname as tbl
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public'
          and c.relkind = 'r'
          and not c.relrowsecurity
          and exists (
            select 1 from information_schema.columns col
             where col.table_schema = 'public'
               and col.table_name = c.relname
               and col.column_name = 'organization_id'
          )
        order by c.relname`
    )
  );
  if (unlisted.length === 0) {
    line(true, "derived from organization_id", "every tenant table has RLS on");
  } else {
    for (const row of unlisted) {
      line(false, row.tbl, "has organization_id and NO row-level security");
    }
  }

  // ---- 3 & 4. do they filter, and do they let work through ----
  const organizations = await withAllTenants("rls-verify: tenants", () => listOrganizations());
  if (organizations.length < 2) {
    console.log("\nIsolation: skipped — need two organizations to test one against the other.");
  } else {
    // The tenant being hidden must be the one that HAS rows. The first version
    // took organizations[0] and [1], which on this platform are two businesses
    // with no contacts at all — so "invisible" was true because there was
    // nothing to hide. It passed, proved nothing, and read identically to a
    // real pass. A test that cannot fail is not evidence.
    const counts = await withAllTenants("rls-verify: find the tenant with data", async () => {
      const { rows } = await getPool().query<{ organization_id: string; n: string }>(
        `select organization_id, count(*)::text as n from contacts group by organization_id`
      );
      return new Map(rows.map((row) => [row.organization_id, Number(row.n)]));
    });

    const b = [...organizations].sort((x, y) => (counts.get(y.id) ?? 0) - (counts.get(x.id) ?? 0))[0];
    const a = organizations.find((org) => org.id !== b.id)!;
    const hidden = counts.get(b.id) ?? 0;

    if (hidden === 0) {
      console.log(
        "\nIsolation: NOT TESTABLE — no business has any contacts, so nothing could" +
          "\n  leak and a pass here would mean nothing. Re-run once a second business" +
          "\n  has traffic."
      );
      failures++;
    }
    console.log(`\nIsolation (${a.slug} must not see ${b.slug}'s ${hidden} contacts)`);

    // The decisive check. Inside A's context, ask for rows that belong to B.
    // Without RLS this returns B's real count; with RLS it must return zero.
    const leaked = await withTenant(a.id, async () => {
      const { rows } = await getPool().query<{ n: string }>(
        `select count(*)::text as n from contacts where organization_id = $1`,
        [b.id]
      );
      return Number(rows[0].n);
    });
    line(
      leaked === 0,
      `contacts of ${b.slug}`,
      leaked === 0
        ? hidden > 0
          ? `${hidden} rows invisible`
          : "nothing to hide — see above"
        : `LEAKED ${leaked} rows`
    );

    // A SHARPER QUESTION THAN "CAN A SEE B'S ROWS", because after migration 054
    // that question has a legitimate yes.
    //
    // All five businesses answer on one number, so a conversation routed to ABR
    // is OWNED by Zipicka. ABR must be able to read it -- it is ABR's customer,
    // and until 054 ABR's own inbox was empty while they waited. Counting by
    // organization_id therefore reported that correct behaviour as a leak, on
    // exactly one row, which is the shape a real leak also has.
    //
    // So this asks the question that stayed true: can this business see a
    // conversation that is NEITHER its own NOR one it is serving? Strictly
    // stronger than the old assertion -- it covers every other tenant at once
    // rather than one named comparison -- and it still fails on a genuine leak.
    const leakedConversations = await withTenant(a.id, async () => {
      const { rows } = await getPool().query<{ n: string }>(
        `select count(*)::text as n
           from conversations
          where organization_id <> $1
            and coalesce(routed_organization_id, organization_id) <> $1`,
        [a.id]
      );
      return Number(rows[0].n);
    });
    line(
      leakedConversations === 0,
      `conversations neither owned nor served by ${a.slug}`,
      leakedConversations === 0
        ? "invisible"
        : `LEAKED ${leakedConversations} rows — ${a.slug} can read someone else's customers`
    );
  }

  // A policy that hides everything is "secure" and useless — and is precisely
  // what a wrong policy looks like. So prove the tenant still sees itself.
  console.log("\nOwn rows still visible");
  for (const org of organizations) {
    const own = await withTenant(org.id, async () => {
      const { rows } = await getPool().query<{ n: string }>(
        `select count(*)::text as n from contacts`
      );
      return Number(rows[0].n);
    });
    const viaAll = await withAllTenants("rls-verify: baseline", async () => {
      const { rows } = await getPool().query<{ n: string }>(
        `select count(*)::text as n from contacts where organization_id = $1`,
        [org.id]
      );
      return Number(rows[0].n);
    });
    line(own === viaAll, org.slug, `${own} contacts (expected ${viaAll})`);
  }

  console.log(
    failures === 0
      ? "\nPASS — policies are on, they hide other tenants, and they do not hide the tenant's own rows.\n"
      : `\nFAIL — ${failures} problem(s). Roll back with: alter table <t> disable row level security.\n`
  );

  await getPool().end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
