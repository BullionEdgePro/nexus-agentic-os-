-- ============================================================
-- The workflow board
-- ============================================================
--
-- 3 Nov 2026. SFS International's staff move units through the supply steps
-- of the boss's workflow (S5 Classify unit … S10 Portals + social) and deals
-- through the demand steps (D3 Cold lead … D9 CRM & commission). Nexus had no
-- record of either, so eleven of the twenty steps had nothing behind them.
-- Spec: docs/superpowers/specs/2026-11-03-sfs-workflow-board-design.md §4
--
-- Every table carries organization_id under the standard tenant policy, so a
-- query that forgets its business still cannot read another one's inventory.
--
-- CARDS CLOSE; THEY ARE NEVER DELETED. A unit is let, sold or withdrawn and a
-- deal is won or lost; the app role has no DELETE on either table, so "where
-- did that listing go" always has an answer. The database's default
-- privileges give nexus_app every right on a new table (as 050 found), so
-- each right a grant leaves out is revoked by name, not just not granted.
--
-- THE HISTORY IS ONLY ADDED TO. workflow_moves takes SELECT and INSERT and
-- nothing else. Who moved a card is at most one person here; the module always
-- names exactly one. "Exactly one" cannot live in the database: when an
-- employee or an admin row goes, ON DELETE SET NULL clears their id, and a
-- check would refuse that — and with it the removal of a whole business.
--
-- THE PERMIT. Dubai forbids advertising a property without a valid Trakheesi
-- permit, so a unit on S9 or S10 must have a Form A date, a permit number and
-- an expiry on file — refused here as well as in the API. That the expiry is
-- still ahead depends on the day, so the API checks that part.
--
-- Applied by hand as the owner role, before the code that reads it is deployed.
-- Safe to run twice.

begin;
set local lock_timeout = '5s';

create table if not exists property_units (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references organizations(id) on delete cascade,

  step                   text not null check (step in ('S5', 'S6', 'S7', 'S8', 'S9', 'S10')),
  in_step_since          timestamptz not null default now(),

  -- "Marina Gate 2 · 1204": how the team names the unit.
  reference              text not null check (btrim(reference) <> ''),
  community              text,
  property_type          text check (property_type in ('apartment', 'villa', 'townhouse', 'penthouse', 'office', 'shop', 'warehouse', 'land', 'other')),
  bedrooms               smallint check (bedrooms between 0 and 50), -- 0 is a studio
  purpose                text check (purpose in ('rent', 'sale')),   -- set by the drop on Rent units or Sale units
  price_aed              numeric(14, 2) check (price_aed >= 0),      -- the yearly rent or the asking price
  cheques                smallint check (cheques between 1 and 12),

  ejari_ready            boolean not null default false,
  title_deed             boolean not null default false,
  owner_docs             boolean not null default false,
  form_a_signed_on       date,
  permit_number          text,
  permit_expires_on      date,
  live_on                text[] not null default '{}'
                         check (live_on <@ array['bayut', 'dubizzle', 'property_finder', 'meta', 'tiktok']::text[]),

  owner_contact_id       uuid references contacts(id) on delete set null,
  agent_employee_id      uuid references employees(id) on delete set null,
  notes                  text,

  closed_at              timestamptz,
  closed_reason          text check (closed_reason in ('let', 'sold', 'withdrawn')),

  created_by_employee_id uuid references employees(id) on delete set null,
  created_by_admin_id    uuid references admins(id) on delete set null,
  updated_by_employee_id uuid references employees(id) on delete set null,
  updated_by_admin_id    uuid references admins(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint property_units_closed_together check ((closed_at is null) = (closed_reason is null)),
  constraint property_units_branch check ((step <> 'S6' or purpose = 'rent') and (step <> 'S7' or purpose = 'sale')),
  constraint property_units_classified check (step = 'S5' or purpose is not null),
  constraint property_units_permit_to_advertise check (
    step not in ('S9', 'S10')
    or (form_a_signed_on is not null and nullif(btrim(permit_number), '') is not null and permit_expires_on is not null)
  )
);
create index if not exists property_units_open_by_step on property_units (organization_id, step) where closed_at is null;

alter table property_units enable row level security;
drop policy if exists property_units_tenant_isolation on property_units;
create policy property_units_tenant_isolation on property_units
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update on property_units to nexus_app;
revoke delete on property_units from nexus_app;

create table if not exists property_deals (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references organizations(id) on delete cascade,

  -- The lead. May be a customer this business serves on a shared number but
  -- does not own; the API checks it can read them before linking.
  contact_id             uuid not null references contacts(id) on delete cascade,
  step                   text not null check (step in ('D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9')),
  in_step_since          timestamptz not null default now(),
  purpose                text not null check (purpose in ('rent', 'sale')), -- the lead says which

  budget_aed             numeric(14, 2) check (budget_aed >= 0),
  offer_aed              numeric(14, 2) check (offer_aed >= 0),
  deal_value_aed         numeric(14, 2) check (deal_value_aed >= 0),
  commission_aed         numeric(14, 2) check (commission_aed >= 0),

  ejari_number           text,
  kyc_done               boolean not null default false,
  form_f_signed_on       date,
  dld_transfer_on        date,

  agent_employee_id      uuid references employees(id) on delete set null,
  notes                  text,

  closed_at              timestamptz,
  closed_reason          text check (closed_reason in ('won', 'lost')),

  created_by_employee_id uuid references employees(id) on delete set null,
  created_by_admin_id    uuid references admins(id) on delete set null,
  updated_by_employee_id uuid references employees(id) on delete set null,
  updated_by_admin_id    uuid references admins(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint property_deals_closed_together check ((closed_at is null) = (closed_reason is null)),
  constraint property_deals_branch check ((step <> 'D7' or purpose = 'rent') and (step <> 'D8' or purpose = 'sale'))
);
-- One open deal per lead and purpose: two people putting the same hot lead on
-- the board at once make one card, not two.
create unique index if not exists property_deals_one_open on property_deals (organization_id, contact_id, purpose) where closed_at is null;
create index if not exists property_deals_open_by_step on property_deals (organization_id, step) where closed_at is null;

alter table property_deals enable row level security;
drop policy if exists property_deals_tenant_isolation on property_deals;
create policy property_deals_tenant_isolation on property_deals
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update on property_deals to nexus_app;
revoke delete on property_deals from nexus_app;

-- The units offered to a deal (D4 Unit matcher). Unlinking is a real delete:
-- a link is a working note, not a record of anything that happened.
create table if not exists property_deal_units (
  organization_id      uuid not null references organizations(id) on delete cascade,
  deal_id              uuid not null references property_deals(id) on delete cascade,
  unit_id              uuid not null references property_units(id) on delete cascade,
  added_at             timestamptz not null default now(),
  added_by_employee_id uuid references employees(id) on delete set null,
  added_by_admin_id    uuid references admins(id) on delete set null,
  primary key (deal_id, unit_id)
);
create index if not exists property_deal_units_by_unit on property_deal_units (unit_id);

alter table property_deal_units enable row level security;
drop policy if exists property_deal_units_tenant_isolation on property_deal_units;
create policy property_deal_units_tenant_isolation on property_deal_units
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, delete on property_deal_units to nexus_app;
revoke update on property_deal_units from nexus_app;

create table if not exists workflow_moves (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  unit_id         uuid references property_units(id) on delete cascade,
  deal_id         uuid references property_deals(id) on delete cascade,
  kind            text not null check (kind in ('created', 'moved', 'closed')),
  from_step       text,  -- null when created
  to_step         text,  -- null when closed
  closed_reason   text,
  by_employee_id  uuid references employees(id) on delete set null,
  by_admin_id     uuid references admins(id) on delete set null,
  at              timestamptz not null default now(),

  constraint workflow_moves_one_card check ((unit_id is null) <> (deal_id is null)),
  constraint workflow_moves_one_person check (by_employee_id is null or by_admin_id is null)
);
create index if not exists workflow_moves_by_time on workflow_moves (organization_id, at);
create index if not exists workflow_moves_by_unit on workflow_moves (unit_id) where unit_id is not null;
create index if not exists workflow_moves_by_deal on workflow_moves (deal_id) where deal_id is not null;

alter table workflow_moves enable row level security;
drop policy if exists workflow_moves_tenant_isolation on workflow_moves;
create policy workflow_moves_tenant_isolation on workflow_moves
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert on workflow_moves to nexus_app;
revoke update, delete on workflow_moves from nexus_app;

commit;
