-- serving-check only ever ran when somebody ran it.
--
-- ============================================================
-- WHAT THIS CLOSES
-- ============================================================
--
-- `serving-check` was added on 2026-08-26 as the twelfth gate and the only one
-- that asks from outside: it calls the public hostnames over the public
-- internet, so Caddy, TLS and DNS are all in the path. Eleven gates would pass
-- unchanged on a platform nobody could reach; this one would not.
--
-- And it runs when a person types `./scripts/verify-all.sh`. Between deploys
-- that is nobody, for days. A wedged api container, a certificate that expired
-- overnight or a Caddy upstream pointed at the wrong port would go unnoticed
-- until the next release — while every customer message went unanswered and the
-- deck, served by the same web container, was equally unreachable to whoever
-- might have looked.
--
-- The platform's own summary of that hole, written into backup-check and true
-- again here: it closes the hole where nothing COULD notice, not the hole where
-- nobody is looking.
--
-- ============================================================
-- WHAT IT HONESTLY COVERS
-- ============================================================
--
-- The probe runs from cron ON THIS MACHINE, so "outside" means outside the
-- containers — through Caddy, through TLS, through the public hostname. That
-- catches the realistic failures: a wedged API, a misrouted proxy, an expired
-- certificate, a web container that will not serve.
--
-- It does NOT catch the whole machine being down or cut off from the internet.
-- Nothing running on a box can report that the box is gone, and pretending
-- otherwise would be the same false comfort this table exists to remove. That
-- case still needs a monitor somewhere else, and this does not stand in for it.
--
-- ONE ROW PER PROBE. "The last check passed" and "the last check passed and the
-- nine before it failed" must not look the same, and they do if a single row is
-- overwritten.

create table if not exists outside_probes (
  id         uuid primary key default gen_random_uuid(),
  -- No organization_id: reachability is a property of the platform, not of any
  -- one business. Same reasoning as backup_runs, and the same policy below.
  ran_at     timestamptz not null default now(),
  ok         boolean     not null,
  -- How long the API took to answer. serving-check waits up to sixty seconds
  -- for a container that has just restarted, and a platform that needs forty of
  -- them after every deploy is a real fact worth keeping rather than a pass.
  waited_ms  integer,
  -- The gate's own failing line, already written for a person to read.
  detail     text
);

create index if not exists idx_outside_probes_recent on outside_probes (ran_at desc);

-- Enabled rather than exempted, for the reason set out at length in migration
-- 070: a check that can be argued around is one people learn to argue around.
-- The rows carry a timestamp, a boolean, a duration and an HTTP status line —
-- there is no tenant whose data this is, and every business is equally affected
-- by the platform being unreachable.
alter table outside_probes enable row level security;

drop policy if exists outside_probes_readable_in_any_tenant on outside_probes;
create policy outside_probes_readable_in_any_tenant on outside_probes
  using (true)
  with check (true);
