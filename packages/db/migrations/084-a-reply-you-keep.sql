-- ============================================================
-- Quick replies (canned responses)
-- ============================================================
--
-- A message a business writes once and reuses — "our opening hours", "how to
-- pay", "we'll be with you shortly". The single most-used control in any team
-- inbox after the message box itself: staff answer the same handful of
-- questions all day, and retyping the answer each time is the tax this removes.
--
-- Scoped to the BUSINESS, not the person — a reply is the business's voice, and
-- a new colleague should inherit the library rather than rebuild it. Tenant
-- isolation is the same policy every customer-facing table carries; a quick
-- reply is only ever inserted, listed and deleted under one org's context.

create table if not exists quick_replies (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,

  -- A short label to find it by, and the message it drops into the box.
  title            text not null,
  body             text not null,

  -- Who added it (a session subject), for nothing more than showing provenance.
  created_by       text,
  created_at       timestamptz not null default now()
);

-- The list query: a business's replies, newest first.
create index if not exists idx_quick_replies_org
  on quick_replies (organization_id, created_at desc);

alter table quick_replies enable row level security;
drop policy if exists quick_replies_tenant_isolation on quick_replies;
create policy quick_replies_tenant_isolation on quick_replies
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- Default privileges (migration 006) already cover new tables, but the feature
-- migrations grant explicitly so the intent is legible at the table.
grant select, insert, update, delete on quick_replies to nexus_app;

do $$
declare
  guarded boolean;
begin
  select relrowsecurity into guarded from pg_class where relname = 'quick_replies';
  if not coalesce(guarded, false) then
    raise exception 'quick_replies was created without row-level security';
  end if;
  raise notice 'quick_replies ready, tenant-isolated';
end $$;
