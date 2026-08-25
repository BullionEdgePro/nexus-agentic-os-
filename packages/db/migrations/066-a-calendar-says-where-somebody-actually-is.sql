-- Calendar presence: the last open sub-item on F1.
--
-- ============================================================
-- WHAT THIS CHANGES ABOUT A PROMISE
-- ============================================================
--
-- `hasStaffOnShift` decides whether the agent may tell a customer that a person
-- will follow up. Until now it could only read a rota -- the hours somebody is
-- contracted to work -- which is right about a Tuesday in general and wrong
-- about this Tuesday, when they are in court until four.
--
-- A rota says when somebody is meant to be available. A calendar says when they
-- actually are. Promising a customer the first when the second says otherwise is
-- how "a specialist is following up" becomes nobody following up, which is the
-- §9.5 failure this platform has now closed three separate doors on.
--
-- ============================================================
-- WHY THE URL IS A SECRET AND IS TREATED AS ONE
-- ============================================================
--
-- A published ICS link is bearer access to somebody's diary: whoever holds it
-- reads every event title, attendee and location, with no sign-in. It is stored
-- here because it must be fetched, and it is NEVER serialised to a browser --
-- the same rule the operator alert webhook holds itself to, for the same reason
-- and after the same mistake. The screen is told whether a calendar is
-- connected and which host it points at, and nothing else.

create table if not exists employee_calendars (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,

  -- One feed per person. Somebody with two calendars publishes a combined link
  -- from their own client; two rows here would mean two syncs racing to replace
  -- each other's busy blocks.
  employee_id       uuid not null unique references employees(id) on delete cascade,

  ics_url           text not null,
  is_active         boolean not null default true,

  last_synced_at    timestamptz,

  -- Null when the last sync worked. Kept rather than logged, because the person
  -- who pasted a link that has since been revoked is the only one who can fix
  -- it, and they read a screen rather than a container log.
  last_error        text,

  -- Events the parser could not expand -- monthly and yearly recurrences. Shown
  -- next to the connection, because "your calendar is syncing" and "your
  -- calendar is syncing except for the eleven monthly ones" are different
  -- statements and only one of them is safe to act on.
  unsupported_count integer not null default 0,

  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Busy time, replaced wholesale on every sync rather than merged.
--
-- Merging would need to work out which events were DELETED from the calendar
-- since last time, and a deletion that goes unnoticed leaves somebody blocked
-- for a meeting that is not happening. Replacing cannot get that wrong.
create table if not exists calendar_busy (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,

  -- The feed's own id for the event. Not unique: a repeating event has one uid
  -- and many occurrences.
  uid             text not null,

  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  synced_at       timestamptz not null default now()
);

-- The only question asked of this table on the reply path: is this person busy
-- right now. Employee first, then the interval.
create index if not exists idx_calendar_busy_employee_window
  on calendar_busy (employee_id, starts_at, ends_at);

create index if not exists idx_calendar_busy_org
  on calendar_busy (organization_id);

alter table employee_calendars enable row level security;
alter table calendar_busy enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'employee_calendars' and policyname = 'employee_calendars_tenant_isolation') then
    create policy employee_calendars_tenant_isolation on employee_calendars
      using (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all')
      with check (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all');
  end if;

  if not exists (select 1 from pg_policies where tablename = 'calendar_busy' and policyname = 'calendar_busy_tenant_isolation') then
    create policy calendar_busy_tenant_isolation on calendar_busy
      using (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all')
      with check (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all');
  end if;
end $$;

grant select, insert, update, delete on employee_calendars to nexus_app;
grant select, insert, update, delete on calendar_busy to nexus_app;
