-- ============================================================
-- Migration 016 — Real admin accounts
-- ============================================================
--
-- Until now "admin" was not an account. It was ANY email address plus one
-- shared password (`NEXUS_OPERATOR_PASSWORD`), and it signed in through the
-- same form the staff use. Three problems with that, all of which bite the
-- moment a second person is involved:
--
--   * No identity. Every admin action is attributable to "whoever knew the
--     password". There is nothing to audit and nobody to hold responsible.
--   * No revocation. Removing one person's access means changing the secret
--     for everyone and telling them all the new one.
--   * The email field is decorative — it is never checked — which is quietly
--     confusing: it looks like an account and behaves like a passphrase.
--
-- Admins now have named accounts with their own passwords, entered at their own
-- entrance (/admin). Employees keep the front-page form and their access codes.
--
-- Passwords are scrypt-hashed via packages/employees/src/secret.ts, which does
-- NOT normalise — case matters in a password, unlike an access code.
--
-- Idempotent.

create table if not exists admins (
  id             uuid primary key default gen_random_uuid(),
  email          text not null,
  full_name      text not null,
  password_hash  text not null,
  -- Reserved for a future read-only role. Present now so adding one later is a
  -- value change rather than a migration against a live table.
  role           text not null default 'admin' check (role in ('admin')),
  is_active      boolean not null default true,
  last_login_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Case-insensitive uniqueness. Nobody types their own address consistently, and
-- two rows differing only by capitalisation would be two accounts that look
-- like one — with whichever sorted first winning the lookup.
create unique index if not exists idx_admins_email_lower on admins (lower(email));

-- ------------------------------------------------------------
-- No seeded account, and no default password
-- ------------------------------------------------------------
--
-- Seeding one would mean choosing its password here, in version control, and
-- a default admin credential that ships with the schema is a back door whether
-- or not anyone remembers to change it.
--
-- The first admin is created with:
--
--   docker compose -f docker-compose.prod.yml exec -T worker \
--     npx tsx apps/api/src/scripts/create-admin.ts you@example.com "Your Name"
--
-- which generates the password on the server, prints it once, and stores only
-- the hash.
--
-- `NEXUS_OPERATOR_PASSWORD` deliberately keeps working until then. Retiring it
-- in the same change that introduces admin accounts would mean a window where a
-- failed account creation locks everyone out of their own platform.

do $$
begin
  raise notice 'admins table ready — create the first account with apps/api/src/scripts/create-admin.ts';
end
$$;
