-- ============================================================
-- 026 — find a contact's open follow-ups fast
--
-- This lookup runs on the INBOUND REPLY PATH: every message a customer sends
-- now asks "do we owe this person anything?" before the agent answers. That is
-- the one path in the system that must never degrade, so the query gets an
-- index built for exactly its shape rather than relying on the general one.
--
-- Partial, on `status = 'open'`, because closed follow-ups are the majority
-- over time and are never what this asks for. The index therefore stays roughly
-- the size of the outstanding work rather than of all work ever recorded.
--
-- Honest note on scale: with fewer than twenty conversations on this platform
-- today, a sequential scan would be quicker than reading an index. This is not
-- for today. It is because a per-message query with no supporting index is
-- invisible until the table is large, and by then it is slowing down the reply
-- path — the failure this codebase produces most often is the one that looks
-- fine right up until it doesn't.
-- ============================================================

create index if not exists idx_tasks_open_by_contact
  on tasks (organization_id, contact_id, due_at)
  where status = 'open';

do $$
begin
  if not exists (select 1 from pg_indexes where indexname = 'idx_tasks_open_by_contact') then
    raise exception 'idx_tasks_open_by_contact was not created';
  end if;
  raise notice 'open follow-ups are indexed by contact';
end $$;
