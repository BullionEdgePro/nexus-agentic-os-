-- ============================================================
-- Migration 005 — Lead Intelligence (ABOS Phase 3, Feature 3)
-- ============================================================
--
-- Additive and idempotent. Scoring is written best-effort off the reply path,
-- so nothing here can affect whether a customer gets an answer.
--
-- Current state lives on `contacts` (one row per contact, cheap to sort an
-- inbox by) while every individual assessment is appended to
-- `lead_assessments`. Keeping both matters: a score with no record of WHY is
-- unauditable, and "why was this marked urgent" is the first question anyone
-- asks of a scoring system they are being asked to trust.

alter table contacts add column if not exists lead_score      integer;
alter table contacts add column if not exists lead_priority   text
  check (lead_priority is null or lead_priority in ('low', 'normal', 'high', 'urgent'));
alter table contacts add column if not exists lead_category   text;
alter table contacts add column if not exists lead_updated_at timestamptz;

-- Sorting an inbox by "who needs attention first" is the whole point, so the
-- index covers the ordering the UI will actually use.
create index if not exists idx_contacts_lead_priority
  on contacts(organization_id, lead_score desc nulls last)
  where lead_score is not null;

create table if not exists lead_assessments (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  contact_id       uuid not null references contacts(id) on delete cascade,
  conversation_id  uuid references conversations(id) on delete set null,
  message_id       uuid references messages(id) on delete set null,

  score            integer not null,
  priority         text not null check (priority in ('low', 'normal', 'high', 'urgent')),
  category         text not null,

  -- The signals that produced the score, e.g.
  --   [{"name":"purchase_intent","weight":30,"matched":["how much","price"]}]
  -- This is what makes a score explainable after the fact.
  signals          jsonb not null default '[]',

  created_at       timestamptz not null default now()
);

create index if not exists idx_lead_assessments_contact
  on lead_assessments(contact_id, created_at desc);
create index if not exists idx_lead_assessments_org
  on lead_assessments(organization_id, created_at desc);
