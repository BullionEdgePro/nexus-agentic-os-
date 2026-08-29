-- Social accounts a person connects to this platform.
--
-- ============================================================
-- WHAT TIKTOK ACTUALLY ALLOWS, WRITTEN DOWN HERE
-- ============================================================
--
-- The ask was "connect TikTok so staff can manage their clients". TikTok
-- publishes three APIs — Login Kit, the Display API, and Content Posting — and
-- NONE of them exposes direct messages. There is no inbox endpoint at any tier,
-- so "manage clients on TikTok" in the messaging sense is not a feature anybody
-- can build, here or elsewhere.
--
-- What IS possible closes a real loop, and it is the one this platform is
-- already half-way through:
--
--   A staff member puts their referral link in their TikTok bio. People tap it,
--   message the company number, and become that person's clients — all of which
--   already works. What nobody could see was the OTHER half: how the account
--   carrying that link is actually doing, and whether the videos are the reason
--   the leads arrived.
--
-- So a connection stores identity and audience, and the console shows follower
-- count and recent videos NEXT TO the number of conversations that link brought
-- in. That is a question a person can act on. An inbox is not on offer.
--
-- ============================================================
-- WHOSE CONNECTION IT IS
-- ============================================================
--
-- `employee_id` null means the BUSINESS's own account, connected by the owner.
-- Non-null means one staff member's personal account. Same shape as
-- `contacts.owner_employee_id`, deliberately: two pools on one table, and the
-- distinction is an access rule rather than an audit fact.
--
-- ============================================================
-- THE TOKEN IS ENCRYPTED, AND THAT IS NOT OPTIONAL
-- ============================================================
--
-- An OAuth access token is a bearer credential for somebody's real social
-- account. Stored in plain text, a database backup on a laptop becomes a set of
-- live logins to five people's TikTok. It is encrypted at rest with a key held
-- outside the database, so the two have to be stolen together.
--
-- The ciphertext columns are text rather than bytea because they hold
-- base64 of iv:tag:payload — one string that is complete on its own, which
-- survives a dump and restore without anybody thinking about encodings.

create table if not exists social_connections (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,

  -- NULL means the business's own account rather than a person's.
  employee_id       uuid references employees(id) on delete cascade,

  provider          text not null,

  -- Who they are on that platform. Stored so a connection can be NAMED on
  -- screen without a network call, and so a reconnect can tell "the same
  -- account again" from "a different account".
  external_id       text not null,
  display_name      text,
  avatar_url        text,

  -- Encrypted. Never selected into anything a browser sees.
  access_token_enc  text not null,
  refresh_token_enc text,
  expires_at        timestamptz,

  -- What the token may actually do. Recorded because TikTok fails a whole
  -- request when it is asked for one field beyond its scopes, so the code has
  -- to know what it holds rather than assume the full set.
  scopes            text[] not null default '{}',

  connected_at      timestamptz not null default now(),
  -- When the platform was last successfully read. NULL means never since
  -- connecting, which is different from "connected and now failing".
  last_synced_at    timestamptz,
  last_error        text,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One account per person per provider. Reconnecting the same TikTok replaces
-- the row rather than accumulating dead tokens beside it.
create unique index if not exists idx_social_connections_owner
  on social_connections(organization_id, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid), provider);

create index if not exists idx_social_connections_employee
  on social_connections(employee_id) where employee_id is not null;

comment on table social_connections is
  'A social account somebody has connected. TikTok has no direct-message API, so a connection here is identity and audience, never an inbox.';
comment on column social_connections.access_token_enc is
  'AES-256-GCM, base64 iv:tag:ciphertext. Encrypted with a key held outside the database so a stolen dump is not a set of live logins.';
comment on column social_connections.employee_id is
  'NULL means the business''s own account, connected by the owner. Non-null is one staff member''s personal account.';

alter table social_connections enable row level security;

-- Tenant isolation, same shape as everything else here. The employee-level
-- distinction is enforced in the query layer beside contactOwnedBy, for the
-- reason migration 073 sets out at length: an employee clause in the policy
-- must pass when no employee is set — every worker runs that way — so one
-- forgotten set_config would show one person another's connection.
drop policy if exists social_connections_tenant_isolation on social_connections;
create policy social_connections_tenant_isolation on social_connections
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

drop trigger if exists trg_social_connections_updated_at on social_connections;
create trigger trg_social_connections_updated_at
  before update on social_connections
  for each row execute function set_updated_at();
