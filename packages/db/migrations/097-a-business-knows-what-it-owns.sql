-- ============================================================
-- A business knows what it owns (Business HQ)
-- ============================================================
--
-- Spec: docs/superpowers/specs/2026-10-14-business-hq-design.md. One admin-only
-- dashboard per business: its website and domain, SEO and Google Business
-- Profile, social accounts, and a vault of the logins to all of them. Before
-- this, that knowledge lived in sticky notes on a desktop.
--
-- Six tables, all tenant data: every row belongs to one business and sits behind
-- the same RLS policy as the rest. Only the admin-only /api/hq routes read them,
-- through withAllTenants with a named reason.
--
-- The vault stores ONE sealed field, the password (secret_enc, AES-256-GCM under
-- NEXUS_VAULT_KEY, which nothing else uses). Usernames, links and notes stay
-- plain so they can be listed and searched without unsealing anything. Entries
-- are soft-deleted so the reveal log that points at them stays readable.

create table if not exists hq_profiles (
  organization_id        uuid primary key references organizations(id) on delete cascade,
  domain                 text,
  registrar_note         text,
  hosting_note           text,
  platform_note          text,
  gbp_url                text,
  gbp_rating             numeric(2,1) check (gbp_rating is null or gbp_rating between 0 and 5),
  gbp_review_count       integer check (gbp_review_count is null or gbp_review_count >= 0),
  gbp_unanswered_reviews integer check (gbp_unanswered_reviews is null or gbp_unanswered_reviews >= 0),
  gbp_last_post_at       timestamptz,
  gbp_last_photo_at      timestamptz,
  notes                  text,
  updated_at             timestamptz not null default now(),
  updated_by             text
);

create table if not exists hq_keywords (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  keyword          text not null check (char_length(keyword) between 1 and 120),
  position         integer check (position is null or position between 1 and 500),
  checked_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists idx_hq_keywords_org on hq_keywords (organization_id);

create table if not exists hq_social_accounts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  platform          text not null check (platform in
                      ('facebook', 'instagram', 'tiktok', 'linkedin', 'youtube', 'x', 'snapchat', 'google_business', 'other')),
  handle            text,
  url               text,
  followers         integer check (followers is null or followers >= 0),
  last_post_at      timestamptz,
  two_factor        boolean,
  recovery_contact  text,
  vault_entry_id    uuid,
  updated_at        timestamptz not null default now(),
  updated_by        text
);
create index if not exists idx_hq_social_org on hq_social_accounts (organization_id);

create table if not exists hq_vault_entries (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references organizations(id) on delete cascade,
  section            text not null check (section in ('website', 'social', 'other')),
  service            text not null check (char_length(service) between 1 and 80),
  label              text,
  username           text,
  url                text,
  notes              text,
  secret_enc         text,
  secret_changed_at  timestamptz,
  created_by         text,
  updated_by         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index if not exists idx_hq_vault_org on hq_vault_entries (organization_id) where deleted_at is null;

create table if not exists hq_vault_reveals (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  entry_id         uuid not null references hq_vault_entries(id),
  admin_id         text not null,
  revealed_at      timestamptz not null default now(),
  ip               text,
  user_agent       text
);
create index if not exists idx_hq_reveals_org on hq_vault_reveals (organization_id, revealed_at desc);

create table if not exists hq_checks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  kind             text not null check (kind in ('rdap', 'dns', 'tls', 'http', 'speed', 'seo', 'platform')),
  ran_at           timestamptz not null default now(),
  -- null = the check could not run (unknown), never read as passing.
  ok               boolean,
  data             jsonb not null default '{}'::jsonb,
  error            text
);
create index if not exists idx_hq_checks_latest on hq_checks (organization_id, kind, ran_at desc);

alter table hq_profiles enable row level security;
drop policy if exists hq_profiles_tenant_isolation on hq_profiles;
create policy hq_profiles_tenant_isolation on hq_profiles
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');

alter table hq_keywords enable row level security;
drop policy if exists hq_keywords_tenant_isolation on hq_keywords;
create policy hq_keywords_tenant_isolation on hq_keywords
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');

alter table hq_social_accounts enable row level security;
drop policy if exists hq_social_accounts_tenant_isolation on hq_social_accounts;
create policy hq_social_accounts_tenant_isolation on hq_social_accounts
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');

alter table hq_vault_entries enable row level security;
drop policy if exists hq_vault_entries_tenant_isolation on hq_vault_entries;
create policy hq_vault_entries_tenant_isolation on hq_vault_entries
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');

alter table hq_vault_reveals enable row level security;
drop policy if exists hq_vault_reveals_tenant_isolation on hq_vault_reveals;
create policy hq_vault_reveals_tenant_isolation on hq_vault_reveals
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');

alter table hq_checks enable row level security;
drop policy if exists hq_checks_tenant_isolation on hq_checks;
create policy hq_checks_tenant_isolation on hq_checks
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');

grant select, insert, update, delete on hq_profiles, hq_keywords, hq_social_accounts, hq_vault_entries, hq_checks to nexus_app;
-- The reveal log is append-only for the app: it can be written and read, never altered.
grant select, insert on hq_vault_reveals to nexus_app;

do $$
begin
  raise notice 'business hq ready: profiles, keywords, socials, vault, reveal log, checks';
end $$;
