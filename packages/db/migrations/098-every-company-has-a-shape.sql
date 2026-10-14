-- ============================================================
-- Every company has a shape (Business HQ org charts)
-- ============================================================
--
-- Owner-approved 14 Oct 2026: an organizational chart for each company, the
-- owner of all of them on top. Nexus staff appear on their own; this table only
-- holds what an admin adds in Business HQ, so a staff account is never edited:
--
--   kind 'staff'    detail for a Nexus employee (reports-to, department)
--   kind 'manual'   a person who does not use Nexus (accountant, driver…)
--   kind 'vacancy'  an open role, drawn as "Hiring: …"
--
-- reports_to holds a chart node id: 'owner', 'e:<employeeId>' or
-- 'm:<memberId>'. Loops are refused by the API before they are written, and
-- the chart builder hangs anything that cannot reach the top from the owner.
--
-- hq_group is one row: who owns every company. Global, like
-- retired_whatsapp_numbers — it belongs to no single business.

create table if not exists hq_org_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  kind             text not null check (kind in ('staff', 'manual', 'vacancy')),
  employee_id      uuid references employees(id) on delete cascade,
  full_name        text check (full_name is null or char_length(full_name) between 1 and 120),
  job_title        text check (job_title is null or char_length(job_title) between 1 and 120),
  department       text check (department is null or char_length(department) between 1 and 80),
  reports_to       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check ((kind = 'staff') = (employee_id is not null))
);
create unique index if not exists idx_hq_org_members_employee on hq_org_members (organization_id, employee_id) where employee_id is not null;
create index if not exists idx_hq_org_members_org on hq_org_members (organization_id);

alter table hq_org_members enable row level security;
drop policy if exists hq_org_members_tenant_isolation on hq_org_members;
create policy hq_org_members_tenant_isolation on hq_org_members
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');

grant select, insert, update, delete on hq_org_members to nexus_app;

create table if not exists hq_group (
  id           boolean primary key default true check (id),
  owner_name   text not null check (char_length(owner_name) between 1 and 120),
  owner_title  text,
  updated_at   timestamptz not null default now()
);
alter table hq_group enable row level security;
drop policy if exists hq_group_readable on hq_group;
create policy hq_group_readable on hq_group using (true) with check (true);
grant select, insert, update on hq_group to nexus_app;

insert into hq_group (id, owner_name, owner_title) values (true, 'Atif Ali Ali Said', 'Owner')
on conflict (id) do nothing;

do $$
begin
  raise notice 'org charts ready: chart rows per company, and the owner of the group';
end $$;
