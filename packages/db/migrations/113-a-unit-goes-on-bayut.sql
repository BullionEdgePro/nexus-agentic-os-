-- ============================================================
-- A unit goes on Bayut
-- ============================================================
--
-- 23 Nov 2026. Bayut closed its XML feed and now offers only its Profolio API,
-- so Nexus talks to it directly, as it does to Property Finder: a business's
-- admin saves the Bayut API token, each Nexus agent is linked to a Bayut user
-- (the user who posts the listing, and whose licence it carries), each unit
-- holds a Bayut location, and Nexus keeps each unit's Bayut listing in step
-- with "wanted AND ready".
--
-- The token is stored SEALED (AES-256-GCM, the key outside the database,
-- packages/db/src/token-crypto.ts); only its last four characters stay
-- readable, for the screen. What the last check said sits beside them, with the
-- Bayut agency the token belongs to.
--
-- Bayut's answer on a unit's row gains two more words (draft, pending), the
-- time Bayut published it, and the permit comment Bayut gave.
--
-- The database's default privileges give nexus_app every right on a new table
-- (050, 107), so each right a grant leaves out is revoked by name.
--
-- Safe to run twice. Apply as the owner, by hand, BEFORE deploy.sh.
-- Spec: docs/superpowers/specs/2026-11-23-bayut-connection-design.md §4, §5, §6, §13

begin;
set local lock_timeout = '5s';

-- The token and the last check (§4).
alter table portal_settings add column if not exists bayut_token_sealed text;
alter table portal_settings add column if not exists bayut_token_ending text;
alter table portal_settings add column if not exists bayut_agency_id integer;
alter table portal_settings add column if not exists bayut_agency_name text;
alter table portal_settings add column if not exists bayut_checked_at timestamptz;
alter table portal_settings add column if not exists bayut_check_error text;

alter table portal_settings drop constraint if exists portal_settings_bayut_token_ending;
alter table portal_settings add constraint portal_settings_bayut_token_ending
  check (bayut_token_ending is null or char_length(bayut_token_ending) <= 4);
alter table portal_settings drop constraint if exists portal_settings_bayut_agency_name;
alter table portal_settings add constraint portal_settings_bayut_agency_name
  check (bayut_agency_name is null or char_length(bayut_agency_name) <= 200);
alter table portal_settings drop constraint if exists portal_settings_bayut_check_error;
alter table portal_settings add constraint portal_settings_bayut_check_error
  check (bayut_check_error is null or char_length(bayut_check_error) <= 400);

-- The Bayut location on the unit card (§6): an id and its name, both or neither.
alter table property_units add column if not exists bayut_location_id integer;
alter table property_units add column if not exists bayut_location_name text;

alter table property_units drop constraint if exists property_units_bayut_location_id;
alter table property_units add constraint property_units_bayut_location_id
  check (bayut_location_id is null or bayut_location_id > 0);
alter table property_units drop constraint if exists property_units_bayut_location_name;
alter table property_units add constraint property_units_bayut_location_name
  check (bayut_location_name is null or char_length(bayut_location_name) <= 300);
alter table property_units drop constraint if exists property_units_bayut_location_pair;
alter table property_units add constraint property_units_bayut_location_pair
  check ((bayut_location_id is null) = (bayut_location_name is null));

-- Each Nexus agent's Bayut user (§5). A link is changed or removed by an admin.
create table if not exists bayut_agents (
  organization_id  uuid not null references organizations(id) on delete cascade,
  employee_id      uuid not null references employees(id) on delete cascade,
  bayut_user_id    integer not null check (bayut_user_id > 0),
  bayut_user_name  text check (bayut_user_name is null or char_length(bayut_user_name) <= 200),
  linked_at        timestamptz not null default now(),
  primary key (organization_id, employee_id)
);

alter table bayut_agents enable row level security;
drop policy if exists bayut_agents_tenant_isolation on bayut_agents;
create policy bayut_agents_tenant_isolation on bayut_agents
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update, delete on bayut_agents to nexus_app;
revoke truncate, references, trigger on bayut_agents from nexus_app;

-- When Bayut published the unit, and the permit comment it gave (§9, §11).
alter table unit_portals add column if not exists published_at timestamptz;
alter table unit_portals add column if not exists permit_comment text;
alter table unit_portals drop constraint if exists unit_portals_permit_comment;
alter table unit_portals add constraint unit_portals_permit_comment
  check (permit_comment is null or char_length(permit_comment) <= 300);

-- Bayut's answer: the four words of 111, plus draft and pending.
alter table unit_portals drop constraint if exists unit_portals_remote_state;
alter table unit_portals add constraint unit_portals_remote_state
  check (remote_state is null or remote_state in ('live', 'unpublished', 'refused', 'failed', 'draft', 'pending'));

commit;
