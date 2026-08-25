-- Automations: the third word in F7's row, and the one that needed a shape
-- before it needed a table.
--
-- ============================================================
-- WHY THIS IS NOT A SECOND RULES ENGINE
-- ============================================================
--
-- The obvious build is a rules engine that watches the tasks table: "when a
-- follow-up is overdue and unowned, assign it". It is also the wrong build, and
-- the reason is already in this repository. `overdue-followup` and
-- `unowned-followup` watch those exact rows every ten minutes. A second watcher
-- beside them is two things deciding independently what "overdue" means, and
-- the day they disagree, one of them is wrong on a screen nobody is comparing.
--
-- So the operators stay the only eyes. An automation acts on a FINDING the
-- sweep has already raised — the condition is evaluated once, by the code that
-- has always evaluated it, and the automation only decides what to do about it.
--
-- ============================================================
-- WHAT AN AUTOMATION MAY DO
-- ============================================================
--
-- Two actions, both inside one business, both reversible, and neither of them
-- says anything to a customer. That last one is the line: this platform pauses
-- before an agent promises a callback nobody will make, and an automation that
-- could message a customer would be a larger grant than anything the reply path
-- has. Assigning work and writing a note are things a colleague does; sending a
-- message is a thing a business does.
--
--   assign_followup    give an unowned follow-up to a named person
--   create_followup    raise a follow-up so the thing the finding is about
--                      lands on somebody's board instead of only on a list
--
-- ============================================================
-- WHY automation_runs EXISTS
-- ============================================================
--
-- The sweep runs every ten minutes and a finding STANDS until it stops being
-- true. So the same finding is present in six sweeps an hour, and an automation
-- that acted on presence would assign the same task six times an hour and
-- create six follow-ups for one waiting customer.
--
-- The run table is the idempotency, keyed on the automation and the finding
-- together. It is also the audit trail, which is the same fact from the other
-- side: every row here is one automatic act, when, and what it touched.

create table if not exists automations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,

  -- The operator whose findings this reacts to. Text rather than an enum
  -- because operators are code, not data: a new one ships in a deploy and a
  -- constraint listing twenty-one slugs would have to ship with it.
  trigger_operator  text not null,

  action            text not null check (action in ('assign_followup', 'create_followup')),

  -- Who the work goes to. Required by assign_followup and ignored by
  -- create_followup, which leaves the new follow-up unowned on purpose: a
  -- commitment somebody has to pick up is the honest state, and unowned-followup
  -- will say so if nobody does.
  assignee_id       uuid references employees(id) on delete set null,

  is_active         boolean not null default true,

  -- A person, always. An automation created by nobody is one nobody can be
  -- asked about, and the whole point of the layer above this is that a machine
  -- acting on a business's behalf is traceable to somebody who allowed it.
  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index if not exists idx_automations_org_trigger
  on automations (organization_id, trigger_operator) where is_active;

-- One automation per operator per business per action. Two automations both
-- assigning the same finding to different people is a race whose winner is
-- whichever row the planner returned first.
create unique index if not exists automations_one_per_trigger
  on automations (organization_id, trigger_operator, action);

create table if not exists automation_runs (
  id              uuid primary key default gen_random_uuid(),
  automation_id   uuid not null references automations(id) on delete cascade,

  -- Not a foreign key to operator_findings, deliberately. A finding is
  -- RETRACTED and re-raised as the world changes, and this row must outlive
  -- that: it is the record that an automation already acted, and losing it
  -- would let the same act happen again the moment the finding came back.
  finding_id      uuid not null,

  organization_id uuid not null references organizations(id) on delete cascade,
  action          text not null,

  -- What it touched, so the audit trail names the thing rather than the event.
  subject_kind    text,
  subject_id      uuid,

  -- Null when the action succeeded. A failure is recorded rather than retried
  -- forever: an automation that cannot assign because the person left the
  -- business should say so once, not every ten minutes.
  failed_reason   text,

  ran_at          timestamptz not null default now()
);

-- The idempotency itself. Present for failures too: an automation that failed
-- on this finding must not be retried on the next sweep, because the reason it
-- failed is almost never going to change in ten minutes and the log would fill
-- with the same sentence.
create unique index if not exists automation_runs_once_per_finding
  on automation_runs (automation_id, finding_id);

create index if not exists idx_automation_runs_org
  on automation_runs (organization_id, ran_at desc);

alter table automations enable row level security;
alter table automation_runs enable row level security;

-- Tenant isolation, in the shape rls-verify now enforces: the write predicate is
-- no wider than the read. Neither table has a serving-business dimension — an
-- automation belongs to the business that created it — so both sides are the
-- plain one.
do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'automations' and policyname = 'automations_tenant_isolation') then
    create policy automations_tenant_isolation on automations
      using (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all')
      with check (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all');
  end if;

  if not exists (select 1 from pg_policies where tablename = 'automation_runs' and policyname = 'automation_runs_tenant_isolation') then
    create policy automation_runs_tenant_isolation on automation_runs
      using (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all')
      with check (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all');
  end if;
end $$;

grant select, insert, update, delete on automations to nexus_app;
grant select, insert, update, delete on automation_runs to nexus_app;
