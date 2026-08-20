-- Three columns the whole reply path branches on, and none of them constrained.
--
-- Found by listing every enumerated check constraint in the database and
-- comparing each against the TypeScript union that models it. Every pair that
-- existed agreed -- reply_outcome, retrieval_outcome, resolved_by,
-- hallucination_risk, phrase moments, presence, broadcast status. No drift.
--
-- What the comparison actually turned up is three unions with NO counterpart:
--
--   messages.direction     inbound | outbound
--   messages.sender_type   contact | ai_agent | human_agent | system
--   messages.status        queued | sent | delivered | read | failed
--
-- The database would accept any string in them, and these are not incidental
-- columns. `customer-waiting` decides a customer is waiting by testing
-- `last.sender_type = 'contact'`. `delivery-failing` counts
-- `direction = 'outbound'`. The delivery ladder orders `status`. A row written
-- with 'Contact' or 'OUTBOUND' would satisfy no query and break no query --
-- it would simply never be counted, by anything, silently.
--
-- SAFE TO ADD, MEASURED FIRST. Every value in production today is already
-- inside its union:
--
--   direction     inbound, outbound
--   sender_type   ai_agent, contact, human_agent, system
--   status        delivered, sent
--
-- status is left nullable because it legitimately is: an inbound message has no
-- delivery state of ours to record.
--
-- The lists are duplicated here from packages/shared/src/types.ts, which is a
-- second place to type the same thing and therefore a thing that can drift.
-- `a-union-and-its-constraint-agree` compares them and fails if they do.

alter table messages
  drop constraint if exists messages_direction_check;
alter table messages
  add constraint messages_direction_check
  check (direction = any (array['inbound', 'outbound']));

alter table messages
  drop constraint if exists messages_sender_type_check;
alter table messages
  add constraint messages_sender_type_check
  check (sender_type = any (array['contact', 'ai_agent', 'human_agent', 'system']));

alter table messages
  drop constraint if exists messages_status_check;
alter table messages
  add constraint messages_status_check
  check (status is null or status = any (array['queued', 'sent', 'delivered', 'read', 'failed']));

do $$
declare
  n int;
begin
  select count(*) into n
    from pg_constraint
   where conrelid = 'messages'::regclass
     and contype = 'c'
     and conname in ('messages_direction_check', 'messages_sender_type_check', 'messages_status_check');

  if n <> 3 then
    raise exception 'expected three constraints on messages, found %', n;
  end if;

  raise notice 'The three columns the reply path branches on now refuse a value nothing would match.';
end $$;
