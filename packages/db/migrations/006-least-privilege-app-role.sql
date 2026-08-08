-- ============================================================
-- Migration 006 — Least-privilege application role
-- ============================================================
--
-- The application connects as `nexus`, which is a Postgres SUPERUSER and owns
-- every table. Two problems:
--
--   1. Superusers bypass row-level security unconditionally. FORCE ROW LEVEL
--      SECURITY does not apply to them either, so enabling RLS while the app
--      runs as `nexus` would deploy policies that enforce nothing while
--      appearing to protect the data.
--   2. Least privilege: any SQL injection anywhere currently escalates to full
--      database control.
--
-- This grants a plain `nexus_app` role exactly the DML it needs and nothing
-- more — no DDL, no superuser, not a table owner. Migrations continue to run as
-- `nexus`; only the running application uses `nexus_app`.
--
-- The role itself is created separately with a password generated on the
-- server, so no credential ever appears in version control.
--
-- Idempotent: safe to re-run. Does nothing at all if the role is absent, so
-- applying this before creating the role cannot fail a deploy.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'nexus_app') then
    raise notice 'Role nexus_app does not exist yet — skipping grants.';
    return;
  end if;

  execute 'grant usage on schema public to nexus_app';

  -- DML only. No CREATE/ALTER/DROP: the app never changes its own schema.
  execute 'grant select, insert, update, delete on all tables in schema public to nexus_app';
  execute 'grant usage, select on all sequences in schema public to nexus_app';
  execute 'grant execute on all functions in schema public to nexus_app';

  -- Future objects created by `nexus` (i.e. by the next migration) are granted
  -- automatically. Without this, every new table would silently be unreadable
  -- by the application until someone remembered to grant it.
  execute 'alter default privileges for role nexus in schema public
             grant select, insert, update, delete on tables to nexus_app';
  execute 'alter default privileges for role nexus in schema public
             grant usage, select on sequences to nexus_app';
  execute 'alter default privileges for role nexus in schema public
             grant execute on functions to nexus_app';

  raise notice 'Granted least-privilege DML on public schema to nexus_app.';
end
$$;
