-- ============================================================
-- A unit kept off-market
-- ============================================================
--
-- 7 Nov 2026. Pocket listings: a unit the owner does not want advertised
-- publicly is marked "pocket" and shown privately — one link per buyer or
-- tenant on the board. A pocket unit never goes on the portals; the API turns
-- its portal switches off and keeps them off.
--
-- Each private link is a row here: an unguessable 43-character token, who it
-- was shared with (the deal, so the buyer's own-book privacy holds), when it
-- stops working, whether it was revoked, when it was opened and how often, and
-- when the buyer said they were interested. One active link per unit and buyer;
-- a link is revoked, never deleted.
--
-- Safe to run twice. Apply as the owner, by hand, BEFORE deploy.sh.
-- Spec: docs/superpowers/specs/2026-11-07-pocket-listings-design.md §2, §8

begin;
set local lock_timeout = '5s';

alter table property_units add column if not exists pocket boolean not null default false;
alter table property_units add column if not exists pocket_since timestamptz;

create table if not exists unit_pocket_shares (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organizations(id) on delete cascade,
  unit_id                 uuid not null references property_units(id) on delete cascade,
  deal_id                 uuid not null references property_deals(id) on delete cascade,
  token                   text not null unique,
  created_by_employee_id  uuid references employees(id) on delete set null,
  created_by_admin_id     uuid references admins(id) on delete set null,
  created_at              timestamptz not null default now(),
  expires_at              timestamptz not null,
  revoked_at              timestamptz,
  first_viewed_at         timestamptz,
  last_viewed_at          timestamptz,
  view_count              integer not null default 0,
  interested_at           timestamptz
);

alter table unit_pocket_shares drop constraint if exists unit_pocket_shares_token_shape;
alter table unit_pocket_shares add constraint unit_pocket_shares_token_shape check (token ~ '^[A-Za-z0-9_-]{43}$');
alter table unit_pocket_shares drop constraint if exists unit_pocket_shares_views;
alter table unit_pocket_shares add constraint unit_pocket_shares_views check (view_count >= 0);

-- One active link per unit and buyer; a revoked one makes room for the next.
create unique index if not exists unit_pocket_shares_one_active on unit_pocket_shares (unit_id, deal_id) where revoked_at is null;
create index if not exists unit_pocket_shares_by_unit on unit_pocket_shares (organization_id, unit_id);

alter table unit_pocket_shares enable row level security;
drop policy if exists unit_pocket_shares_tenant_isolation on unit_pocket_shares;
create policy unit_pocket_shares_tenant_isolation on unit_pocket_shares
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update on unit_pocket_shares to nexus_app;
revoke delete on unit_pocket_shares from nexus_app;

commit;
