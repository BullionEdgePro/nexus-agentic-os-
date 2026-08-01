-- ============================================================
-- Migration 001 — Employee Agent Layer (ABOS Phase 1)
-- ============================================================
--
-- Introduces the Employee bounded context and re-parents the conversation
-- hierarchy from  Tenant → Conversation  to  Tenant → Employee → Conversation.
--
-- DESIGNED TO BE ADDITIVE AND IDEMPOTENT. It is safe to run repeatedly and
-- safe to run against the live production database:
--   * every new column is NULLable with no default backfill,
--   * `conversations.employee_id IS NULL` means "org-level", which is exactly
--     the behaviour every existing row already has, so nothing changes for
--     traffic until an employee is actually created and assigned.
--
-- Run against an existing database with:  npm run migrate -w packages/db

-- ============================================================
-- Employees
-- ============================================================

create table if not exists employees (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references organizations(id) on delete cascade,

  -- Identity
  employee_code             text not null,               -- human-readable, unique per tenant (e.g. 'ivan')
  full_name                 text not null,
  email                     text,
  avatar_url                text,
  job_title                 text,
  department                text,

  -- Access control (Feature 12 hooks into this; kept as jsonb so RBAC/ABAC
  -- can evolve without another migration)
  permissions               jsonb not null default '{}',

  -- Channels. A dedicated phone_number_id is optional: employees without one
  -- share the organization's number and are distinguished by assignment.
  whatsapp_phone_number_id  text,
  whatsapp_number           text,

  -- Scheduling. Working hours/breaks are stored as jsonb rather than a
  -- normalized child table on purpose: presence is resolved on the hot path
  -- of every inbound message, and this keeps it to a single row read with
  -- no join. Shape:
  --   {"mon":[{"start":"09:00","end":"18:00"}], "sat":[], ...}
  timezone                  text not null default 'Asia/Dubai',
  working_hours             jsonb not null default '{}',
  break_schedule            jsonb not null default '{}',

  -- Capability routing
  languages                 text[] not null default '{}',
  skills                    text[] not null default '{}',
  expertise                 text[] not null default '{}',

  -- AI Twin persona
  twin_enabled              boolean not null default true,
  ai_personality            text,                         -- persona description
  response_style            text,                         -- tone/register
  knowledge_collection      text,                         -- RAG namespace (Feature 2)
  escalation_rules          jsonb not null default '{}',

  -- Disclosure. The twin must always identify itself as an AI assistant
  -- acting on the employee's behalf — never as the employee. See
  -- packages/employees/src/twin.ts for why this is enforced in code too.
  twin_disclosure           text,

  -- HUMAN-ONLY. Deliberately never read by the twin: a digital signature is
  -- an attestation by a person. Applying one to machine-generated text is
  -- misrepresentation, and for the legal tenants it is a malpractice vector.
  digital_signature         text,

  -- Presence
  manual_presence           text check (manual_presence in
                              ('online','offline','idle','busy','ai_handling','meeting','vacation','emergency')),
  manual_presence_until     timestamptz,
  last_seen_at              timestamptz,

  -- When true, an ONLINE employee owns their conversations and the twin stays
  -- silent. Defaults to false so enabling the employee layer can never
  -- introduce customer-facing silence — opt in per employee once presence
  -- data is trusted.
  human_first               boolean not null default false,

  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (organization_id, employee_code)
);

create index if not exists idx_employees_org on employees(organization_id) where is_active;
create index if not exists idx_employees_phone on employees(whatsapp_phone_number_id)
  where whatsapp_phone_number_id is not null;

-- ============================================================
-- Conversation / message ownership
-- ============================================================

alter table conversations add column if not exists employee_id uuid references employees(id) on delete set null;
alter table messages      add column if not exists employee_id uuid references employees(id) on delete set null;

create index if not exists idx_conversations_employee on conversations(employee_id, status)
  where employee_id is not null;

-- ============================================================
-- Presence audit trail
-- ============================================================
-- Append-only. Powers the live status feed on the command deck, the
-- "who was handling this when it went wrong" question during incidents, and
-- the burnout/workload signals in Feature 11.

create table if not exists employee_presence_events (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  employee_id     uuid not null references employees(id) on delete cascade,
  status          text not null check (status in
                    ('online','offline','idle','busy','ai_handling','meeting','vacation','emergency')),
  source          text not null check (source in ('manual','schedule','calendar','auto_idle','system')),
  effective_at    timestamptz not null default now()
);

create index if not exists idx_presence_events_employee
  on employee_presence_events(employee_id, effective_at desc);

-- ============================================================
-- Twin handback summaries
-- ============================================================
-- When an employee returns and reclaims a conversation the twin held, the
-- generated catch-up summary is persisted rather than only shown once, so the
-- handback is auditable and survives a page refresh.

create table if not exists twin_handbacks (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  employee_id      uuid not null references employees(id) on delete cascade,
  summary          text not null,
  messages_covered integer not null default 0,
  held_from        timestamptz,
  held_until       timestamptz,
  created_at       timestamptz not null default now()
);

create index if not exists idx_twin_handbacks_conversation
  on twin_handbacks(conversation_id, created_at desc);

-- ============================================================
-- updated_at trigger
-- ============================================================

drop trigger if exists trg_employees_updated_at on employees;
create trigger trg_employees_updated_at before update on employees
  for each row execute function set_updated_at();
