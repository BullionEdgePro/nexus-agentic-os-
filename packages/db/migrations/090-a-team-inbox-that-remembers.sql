-- ============================================================
-- A team inbox that remembers who did what
-- ============================================================
--
-- The DoubleTick-style inbox needed five things the schema could not hold:
--
--   1. RESOLVE. conversations.status has allowed 'resolved' since the first
--      schema, and nothing ever wrote it — the "Closed" folder was always empty.
--      closed_by records who resolved a thread (closed_at already existed).
--
--   2. A TIMELINE OF WHAT HAPPENED TO A THREAD, not only what was said in it:
--      "assigned to Priya", "resolved by Kavya", "reopened by the customer".
--      conversation_custody (062) already records handoffs to and from the AI;
--      conversation_events records the rest. Ordered by seq, not created_at, for
--      the reason 063 gives: now() is frozen for a whole transaction.
--
--   3. UNREAD, PER PERSON. "Unread" was left out on purpose because nothing
--      tracked what anyone had read. conversation_reads is that fact: one row per
--      (conversation, reader), the last time that reader had the thread open.
--      organization_id is the SERVING business — the list query that counts
--      unread runs under that business's tenant scope (routed shared-number
--      traffic belongs to whoever serves it, 054), so the row must be visible
--      there.
--
--   4. NOTES AS A TIMELINE. contacts.notes is one field that the last save
--      overwrites; a team needs "who wrote what, when". conversation_notes keeps
--      each note as its own row. The old field stays, untouched.
--
--   5. PER-BUSINESS INBOX SETTINGS. The pipeline stages and the "waiting too
--      long" threshold were constants in the web bundle. organizations now holds
--      them; null means "use the defaults", so nothing changes until a business
--      chooses.
--
-- And one behaviour: a customer writing to a RESOLVED conversation reopens it
-- (trigger below), instead of the lookups creating a fresh, history-less thread.
-- The writers' lookups were widened to find resolved conversations in the same
-- release. Re-runnable.

-- ------------------------------------------------------------
-- 1. Who resolved it
-- ------------------------------------------------------------
alter table conversations add column if not exists closed_by text;

-- ------------------------------------------------------------
-- 2. conversation_events
-- ------------------------------------------------------------
create table if not exists conversation_events (
  id               uuid primary key default gen_random_uuid(),
  seq              bigserial,
  organization_id  uuid not null references organizations(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  kind             text not null
                   check (kind in ('assigned', 'unassigned', 'resolved', 'reopened')),
  -- A session subject (employee id / admin id), 'customer', or null.
  actor            text,
  -- The name shown in the thread, resolved when it happened so a later rename
  -- does not rewrite history.
  actor_name       text,
  -- For 'assigned': who it was assigned TO.
  subject_name     text,
  created_at       timestamptz not null default now()
);
create index if not exists idx_conversation_events_conversation
  on conversation_events (conversation_id, seq);

alter table conversation_events enable row level security;
drop policy if exists conversation_events_tenant_isolation on conversation_events;
create policy conversation_events_tenant_isolation on conversation_events
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- 3. conversation_reads
-- ------------------------------------------------------------
create table if not exists conversation_reads (
  conversation_id  uuid not null references conversations(id) on delete cascade,
  -- 'e:<employee id>' or 'o:<admin id / session subject>'.
  reader           text not null,
  organization_id  uuid not null references organizations(id) on delete cascade,
  last_read_at     timestamptz not null default now(),
  primary key (conversation_id, reader)
);
create index if not exists idx_conversation_reads_reader
  on conversation_reads (reader);

alter table conversation_reads enable row level security;
drop policy if exists conversation_reads_tenant_isolation on conversation_reads;
create policy conversation_reads_tenant_isolation on conversation_reads
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- 4. conversation_notes
-- ------------------------------------------------------------
create table if not exists conversation_notes (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  author           text,
  author_name      text,
  body             text not null check (length(body) between 1 and 4000),
  created_at       timestamptz not null default now()
);
create index if not exists idx_conversation_notes_conversation
  on conversation_notes (conversation_id, created_at);

alter table conversation_notes enable row level security;
drop policy if exists conversation_notes_tenant_isolation on conversation_notes;
create policy conversation_notes_tenant_isolation on conversation_notes
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- 5. Per-business inbox settings, and a lead source on the contact
-- ------------------------------------------------------------
alter table organizations add column if not exists inbox_stages text[];
alter table organizations add column if not exists sla_minutes integer;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_sla_minutes_range') then
    alter table organizations
      add constraint organizations_sla_minutes_range
      check (sla_minutes is null or sla_minutes between 5 and 10080);
  end if;
end $$;

alter table contacts add column if not exists lead_source text;

-- ------------------------------------------------------------
-- 6. A customer writing to a resolved conversation reopens it
-- ------------------------------------------------------------
-- Runs in the inserting transaction's tenant scope, like the 054 triggers: the
-- message row and its conversation share an organization, so the update and the
-- event insert are visible and allowed wherever the message insert was.
create or replace function reopen_resolved_conversation_on_inbound()
returns trigger as $fn$
declare
  reopened_org uuid;
begin
  update conversations
     set status = 'open', closed_at = null, closed_by = null
   where id = new.conversation_id
     and status = 'resolved'
  returning organization_id into reopened_org;

  if reopened_org is not null then
    insert into conversation_events (organization_id, conversation_id, kind, actor, actor_name)
    values (reopened_org, new.conversation_id, 'reopened', 'customer', 'the customer');
  end if;
  return null;
end;
$fn$ language plpgsql;

drop trigger if exists trg_messages_reopen_resolved on messages;
create trigger trg_messages_reopen_resolved
  after insert on messages
  for each row
  when (new.direction = 'inbound')
  execute function reopen_resolved_conversation_on_inbound();

-- ------------------------------------------------------------
-- Checks
-- ------------------------------------------------------------
do $$
declare
  t text;
  guarded boolean;
begin
  foreach t in array array['conversation_events', 'conversation_reads', 'conversation_notes'] loop
    select relrowsecurity into guarded from pg_class where relname = t;
    if not coalesce(guarded, false) then
      raise exception '% was created without row-level security', t;
    end if;
  end loop;
  if not exists (
    select 1 from information_schema.columns where table_name = 'conversations' and column_name = 'closed_by'
  ) then
    raise exception 'conversations.closed_by was not added';
  end if;
  raise notice 'team inbox ready: events, per-person reads, notes, inbox settings, reopen-on-inbound';
end $$;
