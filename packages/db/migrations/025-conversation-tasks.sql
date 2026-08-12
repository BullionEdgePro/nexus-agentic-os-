-- ============================================================
-- 025 — tasks tied to conversations (F7, the buildable slice)
--
-- The architecture doc puts it plainly: "Full Monday.com parity is years.
-- Boards + tasks tied to conversations is weeks." This is that, and only that.
-- No boards, no swimlanes, no dependencies — a follow-up, attached to the
-- conversation it came from, owned by a named person, with a date.
--
-- THE GAP IT FILLS. An employee takes a customer onto their own phone and gets
-- a briefing of what the agent already promised. Nothing then records what they
-- agreed to DO. On a platform whose whole premise is that conversations become
-- work, the work has been living in people's heads.
--
-- Why conversation_id is nullable: not every task starts in a conversation.
-- "Chase the trade licence renewal" is real work for a business with no
-- customer message behind it. Requiring a conversation would push that work
-- back out into someone's head, which is the thing this replaces.
--
-- Why employee_id is nullable, and why that is surfaced rather than prevented:
-- a task nobody owns is nobody's job, and it will not be done. Refusing to
-- store one would mean the operator writes it on paper instead. Storing it and
-- showing it as unassigned is honest and keeps it in the system where it can be
-- picked up.
--
-- Tenant-scoped, and on the RLS policy list — a task names a customer and what
-- was agreed with them, which is exactly the material tenant isolation exists
-- to protect.
-- ============================================================

create table if not exists tasks (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,

  -- What it came from. Both optional, both indexed: a task opened from a
  -- conversation should be findable from that conversation, and a task about a
  -- customer should be findable from that customer.
  conversation_id   uuid references conversations(id) on delete set null,
  contact_id        uuid references contacts(id) on delete set null,

  -- Whose job it is. Null means nobody's, which the UI shows rather than hides.
  employee_id       uuid references employees(id) on delete set null,

  title             text not null,
  notes             text,

  -- Deliberately a date-time rather than a date: "call them back at 4" is the
  -- common case here, and a date-only column would round that away.
  due_at            timestamptz,

  status            text not null default 'open'
                    check (status in ('open', 'done', 'cancelled')),

  -- Who closed it and when. A task that simply changes state records nothing
  -- about accountability, which is most of the point of assigning it.
  completed_at      timestamptz,
  completed_by      uuid references employees(id) on delete set null,

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_tasks_org_status on tasks (organization_id, status, due_at);
create index if not exists idx_tasks_employee on tasks (employee_id) where status = 'open';
create index if not exists idx_tasks_conversation on tasks (conversation_id);

-- `on delete set null` above rather than cascade, on purpose: deleting a
-- conversation must not silently delete the follow-up someone still owes a
-- customer. The task survives, orphaned but visible.

drop trigger if exists trg_tasks_updated_at on tasks;
create trigger trg_tasks_updated_at before update on tasks
  for each row execute function set_updated_at();

-- Bring it under the same policy every other tenant table carries. Written here
-- rather than left to a re-run of 018, so the table is never briefly unguarded.
alter table tasks enable row level security;
drop policy if exists tasks_tenant_isolation on tasks;
create policy tasks_tenant_isolation on tasks
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

do $$
declare
  guarded boolean;
begin
  select relrowsecurity into guarded from pg_class where relname = 'tasks';
  if not coalesce(guarded, false) then
    raise exception 'tasks was created without row-level security — it holds customer commitments';
  end if;
  raise notice 'tasks ready, tenant-isolated';
end $$;
