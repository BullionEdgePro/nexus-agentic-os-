-- ============================================================
-- A customer list that keeps itself up to date
-- ============================================================
--
-- DoubleTick's Segmentation Studio: "dynamic customer segments" over tags,
-- stages and custom fields, always current. A contact_segments row is a SAVED
-- FILTER, never a saved list of people — it is evaluated at the moment it is
-- used (packages/db/src/segments.ts), so a customer who reaches "Qualified"
-- this morning is in this afternoon's campaign without anyone re-picking them.
--
-- The filter is jsonb, normalised on the way in (normaliseSegmentFilter) so
-- nothing unrecognised is stored. Every evaluation ALSO applies the rules no
-- list can switch off: this business's customers only (contactServedBy),
-- never an opted-out contact, only a contact with a WhatsApp number.
--
-- A broadcast aimed at a list carries {"$segment": "<id>"} as its audience;
-- deleting the list makes that broadcast refuse to send rather than fall back
-- to everyone (apps/api/src/routes/broadcasts.ts).

create table if not exists contact_segments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  filter          jsonb not null default '{}'::jsonb,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_contact_segments_org on contact_segments (organization_id, name);

alter table contact_segments enable row level security;
drop policy if exists contact_segments_tenant_isolation on contact_segments;
create policy contact_segments_tenant_isolation on contact_segments
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

do $$
begin
  if not exists (
    select 1 from pg_class where relname = 'contact_segments' and relrowsecurity
  ) then
    raise exception 'contact_segments was created without row-level security';
  end if;
  raise notice 'customer lists ready: saved filters, evaluated fresh at every use';
end $$;
