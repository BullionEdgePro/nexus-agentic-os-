-- Nothing watches the watchers, and "0 standing findings" is what that looks like.
--
-- Six things are scheduled at worker boot: knowledge re-index (6h), template
-- sync (30m), quality rollup (hourly), operators (10m), procedure inference
-- (daily), forecast cycle (daily). Every one of them is scheduled BEST-EFFORT —
--
--     scheduleOperators()
--       .then(() => logger.info("Operators scheduled (every 10m)"))
--       .catch((err) => logger.warn({ err }, "Could not schedule operators"));
--
-- — which is the right shape, because a scheduling failure must not stop
-- customer messages being answered. What it also means is that any of the six
-- can fail to schedule, or stop repeating, and the platform carries on looking
-- entirely healthy while that whole subsystem is off.
--
-- THE WORST OF THE SIX IS THE OPERATOR SWEEP, because it is the alarm system.
-- If it stops, all fifteen operators go quiet, `operator_findings` stops
-- changing, and the deck reports **0 standing findings** — which is
-- indistinguishable from a platform with nothing wrong. Every other silent
-- failure this codebase has found would then be invisible again, and the thing
-- that was supposed to catch them would be reporting good news.
--
-- The others fail just as quietly and more slowly: knowledge silently stops
-- being re-indexed, template approvals never arrive, the quality rollups freeze
-- at their last value and read as "a quiet week".
--
-- And `/health` returns `{"status":"ok"}` unconditionally. It does not touch the
-- database, the queue, or the schedule; it answers "is this process accepting
-- HTTP" and has been read as "is the platform working".
--
-- So: every scheduled job writes down that it ran. One row per job, updated in
-- place — this is a heartbeat, not a history, and a table that grows by six rows
-- an hour forever to answer "did it run recently" would be its own problem.
--
-- NO organization_id AND NO RLS, deliberately. These jobs are platform
-- infrastructure and run across every business at once; there is no tenant whose
-- row this is. Same category as `organizations`, and readers must therefore say
-- `withAllTenants(reason)` — which is exactly the friction that makes an
-- unscoped read a decision rather than an accident.
create table if not exists job_heartbeats (
  job                text primary key,
  last_started_at    timestamptz,
  -- The one that matters. `last_started_at` moving without this following it
  -- means the job is hanging rather than dead, which is a different fault with
  -- a different fix.
  last_finished_at   timestamptz,
  last_duration_ms   integer,
  -- Kept from the last failure and NOT cleared by a later success. A job that
  -- fails every other run is broken; a field that only ever showed the most
  -- recent outcome would show a green one half the time.
  last_error         text,
  last_error_at      timestamptz,
  runs               bigint not null default 0,
  failures           bigint not null default 0
);

grant select, insert, update on job_heartbeats to nexus_app;

-- No DELETE, for the usual reason and one specific to this table: the rows ARE
-- the evidence that something ran, and a heartbeat that can be removed can be
-- removed by the same fault that stopped the job.
revoke delete on job_heartbeats from nexus_app;
