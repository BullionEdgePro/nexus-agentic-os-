-- ============================================================
-- 019 — Agent quality rollups (F14 cheap version + F9 foundation)
--
-- TWO PROBLEMS, ONE TABLE.
--
-- F14 asks whether the AI is doing a good job. §7 of the architecture doc is
-- blunt about the trap: "Without labelled outcomes, F14 measures its own
-- confidence, which is worse than measuring nothing." An agent scoring its own
-- replies produces a number that rises when the model becomes more fluent and
-- says nothing about whether customers were helped.
--
-- So none of the columns below come from the AI. Every one is a human action
-- the system already recorded:
--
--   a human took the conversation over          → the AI did not finish the job
--   a human replied immediately after the AI    → the AI's answer needed fixing
--   nobody intervened at all                    → the AI handled it
--
-- These are the ground truth F14 needs, and they were already being written
-- down. Nothing new is collected about anyone.
--
-- F9 asks for rollup read models, because the deck aggregates over live tables
-- and that collapses at scale. A daily grain per business is the answer to both
-- questions at once, so it is one table rather than two.
--
-- IDEMPOTENT BY DAY. A rollup that double-counts on re-run is worse than no
-- rollup — the number stays plausible while being wrong, which is this system's
-- signature failure. Recomputing a day replaces it.
-- ============================================================

create table if not exists agent_quality_daily (
  organization_id     uuid not null references organizations(id) on delete cascade,
  day                 date not null,

  -- Volume. Conversations that saw any inbound message that day.
  conversations       integer not null default 0,
  inbound_messages    integer not null default 0,
  ai_messages         integer not null default 0,
  human_messages      integer not null default 0,

  -- Quality, measured only by what humans did.
  ai_answered         integer not null default 0,  -- the AI replied at all
  escalated           integer not null default 0,  -- a human also replied
  ai_only             integer not null default 0,  -- the AI replied, no human did
  corrections         integer not null default 0,  -- a human replied directly after the AI

  -- Cost, so quality is never read without it. An agent that escalates nothing
  -- because it writes essays is not better, it is more expensive.
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,

  -- A day that is still in progress must be readable as incomplete. Without
  -- this, today's partial numbers sit beside finished days and look like a
  -- collapse in volume every morning.
  is_complete         boolean not null default false,
  computed_at         timestamptz not null default now(),

  primary key (organization_id, day)
);

create index if not exists idx_quality_daily_day on agent_quality_daily (day desc);

do $$
declare
  n integer;
begin
  select count(*) into n from agent_quality_daily;
  raise notice 'Agent quality rollups ready: % day-rows stored', n;
end $$;
