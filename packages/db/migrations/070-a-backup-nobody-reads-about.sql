-- A backup that stops running, and the log nobody opens.
--
-- ============================================================
-- WHAT THIS CLOSES
-- ============================================================
--
-- `backup-db.sh` runs at 03:15, dumps the database, restores it into a scratch
-- database to prove the dump is real, and writes the outcome to
-- /var/log/nexus-backup.log. `backup-check.sh` reads the files it left behind
-- and is one of the twelve gates.
--
-- Both are good and neither is enough, and the gate says so itself:
--
--   "This runs when somebody runs it. It closes the hole where nothing COULD
--    notice, not the hole where nobody is looking."
--
-- Measured on 2026-08-27: rclone is installed and /etc/nexus-backup.env exists
-- with BACKUP_REMOTE and BACKUP_PASSPHRASE both EMPTY, so every night's run
-- prints "Off-box copy: SKIPPED" into a log file and stops. Somebody began
-- setting this up, did not finish, and nothing has mentioned it since.
--
-- The same silence covers the worse case. If cron were removed, the disk filled,
-- or Postgres refused the dump, the platform would carry on answering customers
-- with no backup at all and no screen anywhere would differ.
--
-- ============================================================
-- WHY A TABLE AND NOT A LOG SCRAPE
-- ============================================================
--
-- The operators run inside a container; the backup runs on the host. Reading
-- /var/log from the worker would mean mounting the host's log directory into
-- the application, which is a large permission for one fact. The script already
-- talks to Postgres -- it dumps it -- so it records its own outcome, and the
-- operator reads a row like everything else does.
--
-- ONE ROW PER RUN, NOT ONE ROW UPDATED. "The last run succeeded" and "the last
-- run succeeded and the four before it failed" must not look the same, and a
-- single mutable row makes them identical.

create table if not exists backup_runs (
  id            uuid primary key default gen_random_uuid(),
  -- No organization_id, and deliberately: a backup is of the whole database and
  -- belongs to no tenant. It is therefore NOT under row-level security, and the
  -- operator that reads it does so with an explicit cross-tenant reason.
  ran_at        timestamptz not null default now(),
  -- The dump verified by restoring, which is the only evidence that counts.
  verified      boolean     not null,
  -- Null until a copy leaves the machine. This is the field the whole migration
  -- exists for: a dump sitting beside the database it protects.
  off_box       boolean     not null default false,
  size_bytes    bigint,
  tables_seen   integer,
  -- The script's own sentence when something went wrong, for the deck to show.
  failed_reason text
);

-- The operator asks one question -- "what happened most recently" -- and asks it
-- every ten minutes.
create index if not exists idx_backup_runs_recent on backup_runs (ran_at desc);

-- ------------------------------------------------------------
-- Row-level security, on a table with no tenant
-- ------------------------------------------------------------
--
-- Enabled rather than exempted. Migration 052 protected every tenant table and
-- a test holds the line after it: any table created since must enable RLS. The
-- honest answer to that challenge is a policy, not an entry on an exception
-- list -- a check that can be argued around is one people learn to argue
-- around, and the next table added this way might be one that does hold
-- customer data.
--
-- `using (true)` IS THE CORRECT POLICY HERE, and the reason is what the rows
-- contain: a timestamp, a size, a table count, a boolean and the backup
-- script's own error message. No customer name, no phone number, no message
-- body -- there is no tenant whose data this is. And the fact it carries is one
-- every business needs equally: if this dump is not leaving the machine, all
-- five lose their customers together.
--
-- Written out because a bare `using (true)` in a migration is indistinguishable
-- from somebody switching RLS off to make an error go away.
alter table backup_runs enable row level security;

drop policy if exists backup_runs_readable_in_any_tenant on backup_runs;
create policy backup_runs_readable_in_any_tenant on backup_runs
  using (true)
  with check (true);
