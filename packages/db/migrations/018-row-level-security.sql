-- ============================================================
-- 018 — Row-Level Security (step 4 of ARCHITECTURE-ABOS.md §2.2)
--
-- Tenant isolation has been by convention: every query passes organization_id
-- by hand. That holds at five businesses and becomes a data-breach vector as
-- the count grows, because one forgotten WHERE leaks one company's customer
-- conversations into another's screen, with no error and no symptom.
--
-- READ THIS BEFORE APPLYING.
--
-- This file is the dangerous one. A policy with no tenant context does not
-- raise — it returns **zero rows**, which every caller in this codebase reads
-- as "this business has no conversations". Applying it to a deployment whose
-- code has not been converted turns a working platform into an empty-looking
-- one, and the logs stay clean while it happens.
--
-- The prerequisite is migration-independent and lives in the application:
-- `withTenant` / `withAllTenants` in packages/db/src/client.ts, plus the
-- assertion controlled by DB_TENANT_ASSERT. Apply this only once
-- DB_TENANT_ASSERT=strict has run against real traffic without firing.
--
-- WHO IS PROTECTED FROM WHAT. Not from a hostile tenant — per-tenant database
-- logins do not exist here. This protects against a forgotten WHERE clause in
-- our own code, which is the failure that has actually occurred in systems of
-- this shape. The bypass below is therefore a named application-level decision
-- rather than a security boundary, and is documented as such.
--
-- Policies are permissive and read: the row belongs to the current tenant, OR
-- the session has explicitly declared itself cross-tenant. `current_setting`
-- is called with the missing_ok flag so an unset context is null rather than an
-- error — the assertion in application code is what makes an unset context
-- loud, and duplicating that here would break the two legitimate cross-tenant
-- paths (the operator inbox, and the webhook resolving phone_number_id).
--
-- Re-runnable: policies are dropped and recreated on every deploy.
-- ============================================================

-- Row counts before, so the notice at the end can prove the policy did not
-- quietly empty a table. "No error" is not evidence here; a count is.
create temporary table if not exists rls_before (tbl text primary key, n bigint);

do $$
declare
  t text;
  n bigint;
begin
  foreach t in array array[
    'contacts', 'conversations', 'messages', 'employees', 'lead_assessments',
    'knowledge_sources', 'knowledge_chunks', 'message_templates', 'broadcasts',
    'agent_configs', 'ai_message_evaluations', 'conversation_metrics', 'contact_memory'
  ]
  loop
    if to_regclass('public.' || t) is null then
      raise notice 'Skipping %: table does not exist', t;
      continue;
    end if;

    execute format('select count(*) from %I', t) into n;
    insert into rls_before (tbl, n) values (t, n)
      on conflict (tbl) do update set n = excluded.n;

    -- Every covered table must actually have the column the policy reads. A
    -- policy referencing a missing column fails at creation, which is loud and
    -- fine; but checking first gives a message that says which table.
    if not exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = t and column_name = 'organization_id'
    ) then
      raise exception 'Table % has no organization_id; it cannot be tenant-scoped this way', t;
    end if;

    execute format('alter table %I enable row level security', t);

    execute format('drop policy if exists %I on %I', t || '_tenant_isolation', t);
    execute format($p$
      create policy %I on %I
        using (
          organization_id::text = current_setting('app.current_org', true)
          or current_setting('app.tenant_scope', true) = 'all'
        )
        with check (
          organization_id::text = current_setting('app.current_org', true)
          or current_setting('app.tenant_scope', true) = 'all'
        )
    $p$, t || '_tenant_isolation', t);
  end loop;
end $$;

-- The owner (`nexus`, who runs migrations) bypasses RLS unconditionally, which
-- is why this file can still read the tables it just protected. The running
-- application connects as `nexus_app`, a non-owner, so policies apply to it.
-- FORCE ROW LEVEL SECURITY is deliberately NOT set: it would make the owner
-- subject to policies too, and every future migration would then need a tenant
-- context to touch its own tables.
do $$
declare
  r record;
  after_n bigint;
begin
  for r in select tbl, n from rls_before loop
    execute format('select count(*) from %I', r.tbl) into after_n;
    if after_n <> r.n then
      raise exception 'Row count for % changed from % to % while enabling RLS', r.tbl, r.n, after_n;
    end if;
  end loop;

  raise notice 'RLS enabled on % table(s); all row counts unchanged', (select count(*) from rls_before);
  raise notice 'The application role is now policy-bound. Verify a real request returns rows before considering this done.';
end $$;
