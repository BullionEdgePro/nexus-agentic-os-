-- ============================================================
-- Where a staff member is online — the socials they carry their link on
-- ============================================================
--
-- The platform's whole social story is the referral link: staff put it in their
-- bios, and taps route to WhatsApp. Until now there was nowhere to record WHICH
-- socials a person is actually on — so "put your link on your socials" had no
-- list to check it against, and the owner had no way to see a staff member's
-- reach at a glance.
--
-- This is a self-reported directory, not a connected account. It holds handles
-- and links a person types in — never a token, never anything that reads a DM.
-- The connected-account story (Gmail, and TikTok if it is ever un-parked) lives
-- in social_connections; this is the plain "here is where I am" list, so it is a
-- column on the employee, next to the working hours it sits beside on screen.
--
-- jsonb, an array of { platform, label, url }, for the same reason working_hours
-- is jsonb: the shape is small, per-person, and validated in one place on the
-- way in (packages/employees/src/social-accounts.ts) rather than trusted from
-- the client. Re-runnable.

alter table employees
  add column if not exists social_accounts jsonb not null default '[]'::jsonb;
