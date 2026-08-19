-- Four tenant tables have no row-level security, and one holds five businesses.
--
-- Found 2026-08-19 by building the repository's own schema in a throwaway
-- database and diffing it against production. Measured on production:
--
--   agent_quality_daily        195 rows, 5 organizations, RLS off, no policy
--   employee_presence_events     0 rows,                  RLS off, no policy
--   organization_users           0 rows,                  RLS off, no policy
--   twin_handbacks               0 rows,                  RLS off, no policy
--
-- Each has an organization_id, so each is tenant data by construction. None is
-- among the exclusions client.ts documents (organizations, admins,
-- broadcast_recipients, catalog_items) — they were simply never added anywhere.
--
-- THE LIST IS TYPED IN THREE PLACES AND A TABLE IS PROTECTED ONLY IF IT IS IN
-- ALL THREE: migration 018's array, TENANT_SCOPED_TABLES in client.ts, and
-- rls-verify's own copy. 018's array names the thirteen tables that existed
-- when it was written; every table since has depended on its own migration
-- remembering, and four did not. That is not a mistake anyone made twice — it
-- is what a hand-maintained list does.
--
-- So this file DERIVES the set instead of naming it: every table in public with
-- an organization_id column. Re-running it protects anything added since, which
-- makes "a new tenant table is protected" a property of running migrations
-- rather than of remembering.
--
-- WHAT WAS ACTUALLY EXPOSED, stated honestly. The readers of
-- agent_quality_daily all filter on organization_id explicitly, so no query
-- known to exist returned another business's rows. What was missing is the
-- guarantee that a query which forgot the filter would return nothing — the
-- defence this platform relies on precisely because forgetting is the failure
-- it keeps having. Three of the four tables are empty.

create temporary table if not exists rls_52_before (tbl text primary key, n bigint);

do $$
declare
  t text;
  n bigint;
  existing text;
begin
  for t in
    select c.relname
      from pg_class c
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public'
       and c.relkind = 'r'
       and exists (
         select 1 from information_schema.columns col
          where col.table_schema = 'public'
            and col.table_name = c.relname
            and col.column_name = 'organization_id'
       )
     order by c.relname
  loop
    -- Row counts before and after, exactly as 018 does. Enabling RLS as the
    -- owner must not change what the owner can see; if it does, something else
    -- is wrong and this file should stop rather than press on.
    execute format('select count(*) from %I', t) into n;
    insert into rls_52_before (tbl, n) values (t, n)
      on conflict (tbl) do update set n = excluded.n;

    execute format('alter table %I enable row level security', t);

    -- Dropped and recreated rather than created-if-absent, so a policy that
    -- drifted from the standard shape is corrected instead of preserved.
    --
    -- BY SUFFIX, NOT BY EXACT NAME. `reengagement_attempts` carries
    -- `reengagement_tenant_isolation` in production — the table was renamed and
    -- the policy was not. Dropping only the canonical name would have left both
    -- in place; two permissive policies OR together, so nothing would break and
    -- nothing would say so, and the next schema diff would report an extra
    -- object in production forever.
    for existing in
      select policyname from pg_policies
       where schemaname = 'public' and tablename = t
         and policyname like '%\_tenant\_isolation'
    loop
      execute format('drop policy if exists %I on %I', existing, t);
    end loop;
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

do $$
declare
  r record;
  after_n bigint;
  unprotected text;
begin
  for r in select tbl, n from rls_52_before loop
    execute format('select count(*) from %I', r.tbl) into after_n;
    if after_n <> r.n then
      raise exception 'Row count for % changed from % to % while enabling RLS', r.tbl, r.n, after_n;
    end if;
  end loop;

  -- The assertion is the point of the file. Derived the same way as the loop
  -- above, so it cannot pass by agreeing with a list that was already wrong.
  select string_agg(c.relname, ', ' order by c.relname)
    into unprotected
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relkind = 'r'
     and not c.relrowsecurity
     and exists (
       select 1 from information_schema.columns col
        where col.table_schema = 'public'
          and col.table_name = c.relname
          and col.column_name = 'organization_id'
     );

  if unprotected is not null then
    raise exception 'Tenant tables still without row-level security: %', unprotected;
  end if;

  raise notice 'Row-level security holds on % tenant table(s), derived from the schema rather than a list',
    (select count(*) from rls_52_before);
end $$;
