-- ============================================================
-- A unit goes on the portals
-- ============================================================
--
-- 7 Nov 2026. SFS staff list a unit once in Nexus and publish it to Bayut,
-- dubizzle and Property Finder. This adds the listing's own details to the
-- unit, its photos, a publish switch per portal, the business's feed settings
-- (the agency's ORN and the feed address the portals read) and each agent's
-- broker licence (BRN).
-- Spec: docs/superpowers/specs/2026-11-07-portal-listings-design.md §2, §3, §10
--
-- WHAT IS PUBLISHED IS NEVER STORED. A unit is on a portal only while it is
-- wanted there AND ready (a valid permit, the details, 3 photos, the licences),
-- decided each time the feed is read. So a permit that expires or a card that
-- closes takes the listing off the portals with no job and no stale flag.
--
-- PHOTOS ARE WORKING MATERIAL, so they may be removed; a switch is only ever
-- turned off, never deleted, and so are the settings. The database's default
-- privileges give nexus_app every right on a new table (050, 107), so each
-- right a grant leaves out is revoked by name.
--
-- Applied by hand as the owner role, before the code that reads it is deployed.
-- Safe to run twice.

begin;
set local lock_timeout = '5s';

-- The listing on the unit card. All optional on the card; the rule in
-- @nexus/shared (portalProblems) says which are needed to publish.
alter table property_units add column if not exists title          text;
alter table property_units add column if not exists description    text;
alter table property_units add column if not exists size_sqft      numeric(10, 2);
alter table property_units add column if not exists bathrooms      smallint;
alter table property_units add column if not exists furnishing     text;
alter table property_units add column if not exists city           text not null default 'Dubai';
alter table property_units add column if not exists sub_community  text;
alter table property_units add column if not exists building       text;
alter table property_units add column if not exists parking        smallint;
alter table property_units add column if not exists amenities      text[] not null default '{}';
alter table property_units add column if not exists available_from date;

alter table property_units drop constraint if exists property_units_listing_text;
alter table property_units add constraint property_units_listing_text check (
  (title is null or char_length(btrim(title)) between 1 and 120)
  and (description is null or char_length(description) <= 5000)
  and char_length(btrim(city)) between 1 and 100
  and (sub_community is null or char_length(sub_community) <= 200)
  and (building is null or char_length(building) <= 200)
);
alter table property_units drop constraint if exists property_units_listing_numbers;
alter table property_units add constraint property_units_listing_numbers check (
  (size_sqft is null or size_sqft > 0)
  and (bathrooms is null or bathrooms between 0 and 20)
  and (parking is null or parking between 0 and 20)
  and (furnishing is null or furnishing in ('furnished', 'semi_furnished', 'unfurnished'))
);
alter table property_units drop constraint if exists property_units_amenities_known;
alter table property_units add constraint property_units_amenities_known check (
  amenities <@ array['balcony', 'built_in_wardrobes', 'central_ac', 'covered_parking', 'maids_room', 'private_pool', 'shared_pool', 'private_garden', 'shared_gym', 'security', 'concierge', 'view_of_water', 'view_of_landmark', 'pets_allowed', 'kitchen_appliances', 'study', 'childrens_play_area', 'barbecue_area']::text[]
);

-- The photos, in order (0 is the cover). Shrunk in the browser to at most
-- 2048 px; the portals need at least 800 x 600.
create table if not exists unit_photos (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references organizations(id) on delete cascade,
  unit_id                 uuid not null references property_units(id) on delete cascade,
  position                integer not null check (position >= 0),
  bytes                   bytea not null,
  width                   integer not null check (width between 800 and 20000),
  height                  integer not null check (height between 600 and 20000),
  size                    integer not null check (size between 1 and 4194304),
  uploaded_by_employee_id uuid references employees(id) on delete set null,
  uploaded_by_admin_id    uuid references admins(id) on delete set null,
  created_at              timestamptz not null default now(),
  constraint unit_photos_one_place unique (unit_id, position) deferrable initially deferred
);

alter table unit_photos enable row level security;
drop policy if exists unit_photos_tenant_isolation on unit_photos;
create policy unit_photos_tenant_isolation on unit_photos
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update, delete on unit_photos to nexus_app;

-- One switch per unit and portal. The remote_* columns are for phase 2
-- (Property Finder's own reference and its answer).
create table if not exists unit_portals (
  organization_id        uuid not null references organizations(id) on delete cascade,
  unit_id                uuid not null references property_units(id) on delete cascade,
  portal                 text not null check (portal in ('bayut', 'dubizzle', 'property_finder')),
  wanted                 boolean not null default false,
  changed_at             timestamptz not null default now(),
  changed_by_employee_id uuid references employees(id) on delete set null,
  changed_by_admin_id    uuid references admins(id) on delete set null,
  remote_ref             text,
  remote_state           text,
  remote_message         text,
  synced_at              timestamptz,
  primary key (unit_id, portal)
);
create index if not exists unit_portals_wanted on unit_portals (organization_id, portal) where wanted;

alter table unit_portals enable row level security;
drop policy if exists unit_portals_tenant_isolation on unit_portals;
create policy unit_portals_tenant_isolation on unit_portals
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update on unit_portals to nexus_app;
revoke delete on unit_portals from nexus_app;

-- The business's side: its ORN, and the feed address Bayut and dubizzle read.
-- The token unlocks only what the portals publish anyway, so it is kept as is
-- and shown to admins; "New address" replaces it.
create table if not exists portal_settings (
  organization_id   uuid primary key references organizations(id) on delete cascade,
  orn               text check (orn ~ '^\d{1,10}$'),
  feed_token        text unique check (char_length(feed_token) between 1 and 100),
  feed_created_at   timestamptz,
  feed_last_read_at timestamptz,
  feed_last_read_by text check (char_length(feed_last_read_by) <= 200)
);

alter table portal_settings enable row level security;
drop policy if exists portal_settings_tenant_isolation on portal_settings;
create policy portal_settings_tenant_isolation on portal_settings
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update on portal_settings to nexus_app;
revoke delete on portal_settings from nexus_app;

-- The agent's broker licence, shown on every listing.
alter table employees add column if not exists brn text;
alter table employees drop constraint if exists employees_brn_digits;
alter table employees add constraint employees_brn_digits check (brn is null or brn ~ '^\d{1,10}$');

commit;
