-- A customer wrote, the agent chose not to answer, and nothing recorded it.
--
-- Found 2026-08-19 while diagnosing a live message that got no reply. The
-- conversation was in human handover, so `processor.ts` took this branch:
--
--     if (isHumanHandoff || aiPaused) {
--       logger.debug(..., "Skipping AI agent — conversation is in human handoff");
--       return;
--     }
--
-- That is the RIGHT behaviour -- a person had picked the conversation up on
-- 10 August and the customer was addressing them by name; an agent replying
-- over the top of them would be worse than silence. What is wrong is that the
-- decision leaves no trace anywhere:
--
--   * `logger.debug` is below the level the containers log at, so nothing
--     appears in the journal.
--   * The job completes successfully, so the queue shows no failure.
--   * `recordConversationMetric` is never called, so no row exists.
--
-- For seven minutes, with full database access, "the agent skipped this on
-- purpose" was indistinguishable from "the reply path is broken". The owner has
-- no way to tell them apart at all.
--
-- This is migration 049's argument arriving through a door 049 did not cover.
-- 049 exists because replies that failed were absent from the denominator, so
-- the AI resolution rate was 100% by construction. A deliberate silence is
-- absent the same way -- and it is the more common one, because every message
-- into a handed-over conversation takes this branch.
--
-- SO IT BECOMES AN OUTCOME WITH A NAME. `skipped_handover` is not a failure and
-- must never be counted as one; it is the record that a message arrived and the
-- agent stood down on purpose.
--
-- The two operators that read reply_outcome are adjusted alongside this, and
-- one of them in the direction that matters:
--
--   intent-unclassified  excludes it -- no classifier runs on a message the
--                        agent never handled, so a null intent is expected
--                        rather than a fault, and counting it would raise an
--                        URGENT alert every time a human takes a conversation.
--
--   agent-unavailable    excludes it from BOTH halves of its fraction. Leaving
--                        it in the denominator only would dilute the failure
--                        rate with messages the agent was never given a chance
--                        to answer -- which is the same mistake 049 was written
--                        to end, pointing the other way.

do $$
declare
  constraint_name text;
begin
  -- Found by its definition rather than by a guessed name: the constraint was
  -- created inline by migration 049 and carries whatever name Postgres chose.
  select con.conname into constraint_name
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
   where rel.relname = 'conversation_metrics'
     and con.contype = 'c'
     and pg_get_constraintdef(con.oid) like '%reply_outcome%'
   limit 1;

  if constraint_name is not null then
    execute format('alter table conversation_metrics drop constraint %I', constraint_name);
    raise notice 'Dropped % to widen the reply_outcome vocabulary', constraint_name;
  end if;
end $$;

alter table conversation_metrics
  add constraint conversation_metrics_reply_outcome_check
  check (reply_outcome is null
         or reply_outcome in ('agent', 'fallback', 'none', 'agent_unrecorded', 'skipped_handover'));

do $$
declare
  allowed boolean;
begin
  -- SEEDED DATA IS NOT PART OF THE SCHEMA. On a fresh database there is no
  -- conversation to attach a probe row to, so the insert below would affect
  -- zero rows, raise nothing, and report a pass without having tested anything
  -- -- the same silent degradation five earlier migrations were corrected for
  -- this morning. Skipped explicitly instead of passing quietly.
  if not exists (select 1 from conversations) then
    raise notice 'No conversations yet -- the constraint probe cannot run on a fresh database. Skipping.';
    return;
  end if;

  -- Prove the new value is accepted, because a constraint nobody exercised is
  -- indistinguishable from one that permits everything.
  begin
    insert into conversation_metrics
      (organization_id, conversation_id, resolved_by, input_tokens, output_tokens, reply_outcome)
    select c.organization_id, c.id, 'human_agent', 0, 0, 'skipped_handover'
      from conversations c limit 1;
    allowed := true;
  exception when check_violation then
    allowed := false;
  end;

  if not allowed then
    raise exception 'skipped_handover is still refused by the check constraint';
  end if;

  -- Rolled straight back out: this file must leave no analytics row behind.
  delete from conversation_metrics
   where reply_outcome = 'skipped_handover' and input_tokens = 0 and output_tokens = 0
     and recorded_at > now() - interval '1 minute';

  raise notice 'reply_outcome now records a deliberate silence as well as a failure';
end $$;
