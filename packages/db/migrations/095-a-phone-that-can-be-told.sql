-- ============================================================
-- A phone that can be told
-- ============================================================
--
-- Nexus installs on a phone (spec 2026-10-09-nexus-mobile-app-design.md). A
-- row here is one installed device that said yes to notifications: the push
-- service's endpoint plus the two keys a message to it is encrypted with.
--
-- A device belongs to ONE person: subject_kind + subject_id are the session
-- that registered it (an employee, or the owner's admin account), never an id
-- taken from a request body. `subject` is the same key readerOf (lib/actor.ts)
-- gives that person everywhere else — "e:<employeeId>" or "o:<adminId>" — so
-- every read and write that must stay within one person's devices filters on a
-- single column, in the one form the codebase already names people by.
--
-- endpoint is unique: a phone that re-subscribes (a new key, a reinstall)
-- refreshes its own row rather than becoming a second device that buzzes twice.
--
-- The quiet defaults are deliberate. A new device alerts only for the person's
-- OWN chats (mode 'mine') and never shows message text on a lock screen
-- (previews false) until that person turns it on, on that device.
--
-- organization_id is null for the owner, who works across every business; the
-- owner's rows are read through withAllTenants with a named reason.

create table if not exists push_subscriptions (
  id               uuid primary key default gen_random_uuid(),
  subject_kind     text not null check (subject_kind in ('employee', 'operator')),
  subject_id       text not null,
  subject          text generated always as (
                     case subject_kind when 'employee' then 'e:' else 'o:' end || subject_id
                   ) stored,
  organization_id  uuid references organizations(id) on delete cascade,
  endpoint         text not null unique,
  p256dh           text not null,
  auth             text not null,
  user_agent       text,
  label            text check (label is null or char_length(label) between 1 and 60),
  previews         boolean not null default false,
  mode             text not null default 'mine' check (mode in ('mine', 'all', 'paused')),
  created_at       timestamptz not null default now(),
  last_success_at  timestamptz,
  failure_count    integer not null default 0
);
create index if not exists idx_push_subscriptions_subject on push_subscriptions (subject);

alter table push_subscriptions enable row level security;
drop policy if exists push_subscriptions_tenant_isolation on push_subscriptions;
create policy push_subscriptions_tenant_isolation on push_subscriptions
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

grant select, insert, update, delete on push_subscriptions to nexus_app;

do $$
begin
  if not exists (
    select 1 from pg_class where relname = 'push_subscriptions' and relrowsecurity
  ) then
    raise exception 'push_subscriptions was created without row-level security';
  end if;
  raise notice 'push subscriptions ready: one row per device, quiet by default';
end $$;
