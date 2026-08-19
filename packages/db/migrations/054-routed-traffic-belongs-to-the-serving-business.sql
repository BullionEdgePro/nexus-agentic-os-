-- Every per-business number counts routed traffic under the number's owner.
--
-- Measured on production 2026-08-19:
--
--   conversation_metrics   2 rows attributed to zipicka belong to ABR and SFS
--   messages              10 rows attributed to zipicka belong to Juris Prime (6),
--                            SFS (3) and ABR (1)
--
-- THE ROWS ARE NOT WRONG. They must carry the owner's organization_id: the
-- reply path writes them inside the number owner's transaction, and writing the
-- serving business's id would fail the RLS `with check`. What is wrong is that
-- every per-business READ keys on that column, so the owner is inflated and
-- everyone else is emptied -- and under RLS the serving business cannot see the
-- rows at all, so changing a WHERE clause alone would fix nothing.
--
-- The inbox is the most visible instance: `where c.organization_id = $1` shows
-- Juris Prime an empty inbox while its own customers are waiting, and shows
-- Zipicka three conversations it cannot help with.
--
-- ============================================================
-- WHAT THIS CHANGES
-- ============================================================
--
-- `conversations` already records who is serving. Its policy now says so, which
-- is a plain column comparison and costs nothing:
--
--   visible if organization_id matches, OR routed_organization_id matches
--
-- `messages` and `conversation_metrics` have no such column, so they get one,
-- denormalised from the conversation. A SUBQUERY IN A POLICY WAS THE
-- ALTERNATIVE AND IS WORSE TWICE OVER: it runs per row on the hottest table on
-- the platform, and it reads `conversations`, which is itself under RLS -- a
-- policy whose truth depends on another policy is a thing nobody can reason
-- about at three in the morning.
--
-- MAINTAINED BY TRIGGER, NOT BY THE WRITERS. Every writer being careful is the
-- pattern this codebase has now been bitten by seven times; it holds until
-- somebody adds the eighth call site. A trigger makes it a property of the row
-- rather than a rule about the code, and it covers the case no writer could:
-- a conversation ROUTED AFTER its first messages arrived, which is exactly what
-- the triage menu does.
--
-- ORDER MATTERS AND IS DELIBERATE. Migration 052 drops and recreates every
-- `%_tenant_isolation` policy in the standard owner-only shape. It runs before
-- this file, so on a full replay 052 sets the standard shape and this one
-- widens the three tables that need widening. Anything that reverses that order
-- silently narrows them back.

-- ------------------------------------------------------------
-- 1. The column, on both tables
-- ------------------------------------------------------------

alter table messages
  add column if not exists serving_organization_id uuid references organizations(id);
alter table conversation_metrics
  add column if not exists serving_organization_id uuid references organizations(id);

-- ------------------------------------------------------------
-- 2. Kept true by trigger
-- ------------------------------------------------------------

create or replace function set_serving_organization_from_conversation()
returns trigger as $fn$
begin
  select coalesce(c.routed_organization_id, c.organization_id)
    into new.serving_organization_id
    from conversations c
   where c.id = new.conversation_id;
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_messages_serving on messages;
create trigger trg_messages_serving
  before insert or update of conversation_id on messages
  for each row execute function set_serving_organization_from_conversation();

drop trigger if exists trg_conversation_metrics_serving on conversation_metrics;
create trigger trg_conversation_metrics_serving
  before insert or update of conversation_id on conversation_metrics
  for each row execute function set_serving_organization_from_conversation();

-- A conversation is routed AFTER its first message: the customer says "hi",
-- gets the triage menu, and picks a business. Every row already written for
-- that conversation has to follow it, or the opening exchange of every routed
-- conversation stays filed under the owner forever.
create or replace function cascade_serving_organization()
returns trigger as $fn$
begin
  update messages
     set serving_organization_id = coalesce(new.routed_organization_id, new.organization_id)
   where conversation_id = new.id;
  update conversation_metrics
     set serving_organization_id = coalesce(new.routed_organization_id, new.organization_id)
   where conversation_id = new.id;
  return null;
end;
$fn$ language plpgsql;

drop trigger if exists trg_conversations_routing_cascade on conversations;
create trigger trg_conversations_routing_cascade
  after update of routed_organization_id on conversations
  for each row
  when (old.routed_organization_id is distinct from new.routed_organization_id)
  execute function cascade_serving_organization();

-- ------------------------------------------------------------
-- 3. Backfill -- a recomputation, not a guess
-- ------------------------------------------------------------
--
-- Unlike operator_findings in migration 053, this column records an objective
-- fact fully derivable from a row that already exists. There is no "what the
-- code knew at the time" to preserve, so leaving it null would leave every
-- historical number wrong for no reason.

update messages m
   set serving_organization_id = coalesce(c.routed_organization_id, c.organization_id)
  from conversations c
 where c.id = m.conversation_id
   and m.serving_organization_id is distinct from coalesce(c.routed_organization_id, c.organization_id);

update conversation_metrics cm
   set serving_organization_id = coalesce(c.routed_organization_id, c.organization_id)
  from conversations c
 where c.id = cm.conversation_id
   and cm.serving_organization_id is distinct from coalesce(c.routed_organization_id, c.organization_id);

create index if not exists idx_messages_serving
  on messages(serving_organization_id, created_at desc);
create index if not exists idx_conversation_metrics_serving
  on conversation_metrics(serving_organization_id, recorded_at desc);

-- ------------------------------------------------------------
-- 4. The policies, widened to the business being served
-- ------------------------------------------------------------

alter table conversations enable row level security;
drop policy if exists conversations_tenant_isolation on conversations;
create policy conversations_tenant_isolation on conversations
  using (
    organization_id::text = current_setting('app.current_org', true)
    or routed_organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  -- WRITES STAY WITH THE OWNER. A serving business may READ the conversation it
  -- is answering; it may not create one or re-route it. That is the
  -- switchboard's job and the switchboard runs as the owner.
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

do $$
declare
  t text;
begin
  foreach t in array array['messages', 'conversation_metrics']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists %I on %I', t || '_tenant_isolation', t);
    execute format($p$
      create policy %I on %I
        using (
          organization_id::text = current_setting('app.current_org', true)
          or serving_organization_id::text = current_setting('app.current_org', true)
          or current_setting('app.tenant_scope', true) = 'all'
        )
        with check (
          organization_id::text = current_setting('app.current_org', true)
          or current_setting('app.tenant_scope', true) = 'all'
        )
    $p$, t || '_tenant_isolation', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 5. Assert
-- ------------------------------------------------------------

do $$
declare
  unfilled int;
  policy_ok boolean;
begin
  select count(*) into unfilled from messages where serving_organization_id is null;
  if unfilled > 0 then
    raise exception '% message(s) have no serving business after the backfill', unfilled;
  end if;

  select count(*) into unfilled from conversation_metrics where serving_organization_id is null;
  if unfilled > 0 then
    raise exception '% metric row(s) have no serving business after the backfill', unfilled;
  end if;

  select exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'conversations'
       and policyname = 'conversations_tenant_isolation'
       and qual like '%routed_organization_id%'
  ) into policy_ok;
  if not policy_ok then
    raise exception 'the conversations policy does not read routed_organization_id';
  end if;

  raise notice 'Routed traffic is now readable by the business serving it, and counted there.';
end $$;
