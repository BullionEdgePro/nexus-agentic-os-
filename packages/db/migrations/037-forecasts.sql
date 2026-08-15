-- ============================================================
-- 037 — Forecasts (F11 Predictive BI)
--
-- WHAT THIS TABLE IS FOR IS NOT STORING PREDICTIONS. It is for making them
-- falsifiable.
--
-- A forecast is the purest instance of this platform's signature failure. Every
-- other defect found here presented as a plausible normal state — a polite
-- fallback reply, an empty inbox, green containers. A forecast goes one better:
-- it ALWAYS produces a number, it never errors, and it is not even wrong until
-- the day it named arrives. ARCHITECTURE-ABOS.md §9.4 calls F11 on one live
-- tenant "numerology", and that is the correct word for a predicted figure
-- printed next to no record of how the last one did.
--
-- So the columns that matter here are not `predicted`. They are:
--
--   made_at    — when we said it. A forecast written after its day began is a
--                memory wearing a prediction's clothes.
--   baseline   — what the dumbest possible method said at the same moment.
--   actual     — what happened.
--
-- With those three, "is this any good?" is arithmetic. Without them it is a
-- matter of opinion, and the opinion of a system that cannot be wrong is worth
-- nothing.
--
-- ONE ROW PER (business, metric, target day, horizon), AND THE HORIZON IS PART
-- OF THE KEY ON PURPOSE. A forecast made six days out and one made overnight are
-- different claims of different difficulty, and averaging them together produces
-- an accuracy figure that improves whenever the job happens to run late. Keeping
-- them apart is what lets the screen say "a day ahead we are usually within 2;
-- a week ahead we are not much better than guessing".
--
-- WHY THERE IS NO CHECK CONSTRAINT FORBIDDING A BACKDATED FORECAST, given this
-- codebase's own rule about putting guarantees where they cannot be forgotten
-- (see the gist exclusion constraint on `bookings`). It would need `now()`, and
-- a CHECK containing a non-immutable function is not re-evaluated on the rows
-- already stored — so it would look like a guarantee and behave like a
-- suggestion, which is worse than neither. The guarantee lives in two places
-- that do work instead: the writer only ever names days in the future, and the
-- accuracy read filters on `made_at` against the start of the target day. The
-- second is the load-bearing one, because it holds even if somebody inserts a
-- row by hand. A backdated row can therefore exist, and can never earn a score.
--
-- Counts only, and no free text anywhere. Same argument as `shared_patterns` in
-- migration 020, reached from the other end: that table has no prose column
-- because it crosses tenants. This one has none because a forecast is arithmetic
-- over rollups, and a `note` column would eventually hold somebody's explanation
-- of a bad week, which is customer information sitting in a reporting table.
-- ============================================================

create table if not exists forecasts (
  organization_id  uuid not null references organizations(id) on delete cascade,

  -- 'conversations' | 'escalated'. Deliberately narrow. Every metric added here
  -- is a claim the platform is making about someone's business, so they get
  -- added one at a time, on purpose, each with a reason.
  metric           text not null,

  -- The day being predicted, in the BUSINESS's timezone — the same grain and the
  -- same zone as agent_quality_daily, which is the only source. Forecasting in
  -- UTC while the history is rolled up in Dubai time would shift every
  -- prediction by four hours and misalign the weekday seasonality that is the
  -- entire signal.
  target_day       date not null,

  -- 1..7. How far ahead this claim was made. Part of the key; see above.
  horizon_days     smallint not null,

  predicted        numeric(10,2) not null,

  -- An 80% interval derived from this business's OWN backtest residuals, not
  -- from an assumed distribution. On four weeks of history it will be wide and
  -- embarrassing, which is the honest rendering of four weeks of history.
  interval_low     numeric(10,2) not null,
  interval_high    numeric(10,2) not null,

  -- What "the same weekday last week" said, recorded at the same instant from
  -- the same data. THE MOST IMPORTANT COLUMN IN THIS TABLE. A method that cannot
  -- beat this is not intelligence, it is the same numbers with a credential —
  -- and without storing the baseline at prediction time there is no way to find
  -- that out later.
  baseline         numeric(10,2) not null,

  -- Which method produced `predicted`, so a change of method is visible in the
  -- accuracy history rather than silently improving or ruining it.
  method           text not null,

  -- How many complete days the method could see. Evidence, stored with the
  -- claim: an accuracy figure computed across forecasts made from wildly
  -- different amounts of history is an average over two different systems.
  history_days     smallint not null,

  made_at          timestamptz not null default now(),

  -- Filled in once the target day has closed in the business's timezone. NULL
  -- means not yet knowable — never "zero".
  actual           integer,
  scored_at        timestamptz,

  primary key (organization_id, metric, target_day, horizon_days)
);

-- The scorer sweeps unscored rows whose day has closed; the screen reads one
-- business's recent rows. Both are served by this.
create index if not exists forecasts_org_day_idx
  on forecasts (organization_id, target_day desc);

-- Partial, because the scorer's sweep is only ever interested in rows that have
-- not been scored, and that set stays small while the table grows forever.
create index if not exists forecasts_unscored_idx
  on forecasts (target_day)
  where actual is null;

-- Tenant-scoped, and therefore ALSO added to TENANT_SCOPED_TABLES in
-- packages/db/src/client.ts — the guard is a hand-maintained list, and a table
-- missing from it is silently uncovered.
--
-- Worth stating why this table is scoped when `agent_quality_daily`, which is
-- the same shape, is not: that one predates RLS and is protected only by
-- operatorOnly at the route. Following it here would spread a gap rather than a
-- pattern. Two law firms answer on the same WhatsApp number; neither may read
-- the other's volume.
alter table forecasts enable row level security;
drop policy if exists forecasts_tenant_isolation on forecasts;
create policy forecasts_tenant_isolation on forecasts
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- No DELETE, on purpose and for a different reason than `procedures` has one.
-- There, a retired procedure is the record of how a business answered its
-- customers. Here, the rows nobody wants to keep are precisely the wrong ones —
-- and a reporting feature that can quietly drop its own misses will report an
-- accuracy of 100% forever while being useless.
grant select, insert, update on forecasts to nexus_app;

do $$
declare
  n integer;
  scored integer;
begin
  select count(*), count(actual) into n, scored from forecasts;
  raise notice 'Forecasts ready: % stored, % scored against what happened', n, scored;
end $$;
