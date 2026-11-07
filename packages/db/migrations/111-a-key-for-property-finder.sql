-- ============================================================
-- A key for Property Finder
-- ============================================================
--
-- 7 Nov 2026. Phase 2 of portal listings: a business's admin saves the
-- Property Finder API key and secret its Decision Maker made in PF Expert →
-- Developer Resources → API Credentials, and Nexus keeps each unit's Property
-- Finder listing in step with "wanted AND ready".
--
-- The key and secret are stored SEALED (AES-256-GCM, the key outside the
-- database — packages/db/src/token-crypto.ts), as channel tokens are. Only the
-- last four characters of the key are kept readable, for the screen. What the
-- last check said is kept beside them, so a refused key is visible to the admin
-- and stops the sync for that business until it is fixed.
--
-- Each unit's Property Finder row gains a fingerprint of the listing as it was
-- last sent, so a save that changes nothing sends nothing, and its answer is
-- held to four words: live, unpublished, refused, failed.
--
-- Safe to run twice. Apply as the owner, by hand, BEFORE deploy.sh.
-- Spec: docs/superpowers/specs/2026-11-07-property-finder-connection-design.md §3, §5

begin;
set local lock_timeout = '5s';

alter table portal_settings add column if not exists pf_key_sealed text;
alter table portal_settings add column if not exists pf_secret_sealed text;
alter table portal_settings add column if not exists pf_key_ending text;
alter table portal_settings add column if not exists pf_environment text;
alter table portal_settings add column if not exists pf_checked_at timestamptz;
alter table portal_settings add column if not exists pf_check_error text;
-- Which Property Finder account the units' references belong to: a SHA-256 of
-- the environment and the key, never the key. Kept through a disconnect, so the
-- same key coming back keeps its listings; another account (Sandbox → Live, or a
-- new key) starts every unit afresh rather than updating listings it cannot see.
alter table portal_settings add column if not exists pf_account text;

alter table portal_settings drop constraint if exists portal_settings_pf_environment;
alter table portal_settings add constraint portal_settings_pf_environment
  check (pf_environment is null or pf_environment in ('sandbox', 'live'));

-- What was last sent to Property Finder, and its answer in one of four words.
alter table unit_portals add column if not exists remote_fingerprint text;

alter table unit_portals drop constraint if exists unit_portals_remote_state;
alter table unit_portals add constraint unit_portals_remote_state
  check (remote_state is null or remote_state in ('live', 'unpublished', 'refused', 'failed'));

commit;
