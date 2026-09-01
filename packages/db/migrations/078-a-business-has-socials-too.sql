-- ============================================================
-- A business has socials too — the company's own pages
-- ============================================================
--
-- Migration 077 gave each STAFF member a self-reported social directory. This
-- is the same idea one level up: the company's own Facebook page, Instagram,
-- TikTok — recorded by the owner, per business. Same shape, same "directory not
-- a connection" rule (no token, reads no message); it just belongs to the
-- organization rather than a person.
--
-- Reuses the { platform, label, url } shape validated by
-- packages/employees/src/social-accounts.ts, so both levels are checked by one
-- validator. Re-runnable.

alter table organizations
  add column if not exists social_accounts jsonb not null default '[]'::jsonb;
