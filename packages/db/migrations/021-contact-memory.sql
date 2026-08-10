-- ============================================================
-- 021 — Contact memory (F10, the episodic layer)
--
-- The semantic layer already exists: the agent retrieves facts about a business
-- from its knowledge base. What it has never had is memory of a *person*. A
-- customer who spent twenty messages last month arranging an attestation writes
-- in again and is greeted as a stranger, because history is loaded per
-- conversation and a new conversation starts empty.
--
-- This stores one rolling summary per (business, contact), written after their
-- conversations and read when they come back.
--
-- THE EDGE THAT MATTERS ON A SHARED NUMBER.
--
-- All five businesses answer on one WhatsApp number, so the same human being can
-- talk to Zipicka on Monday and ABR on Tuesday from the same handset. Memory
-- keyed on the phone number would carry what someone told a shop into a
-- conversation with a law firm — and the agent would use it, fluently, in front
-- of the customer.
--
-- The key is therefore contact_id, not wa_id. `contacts` is already unique on
-- (organization_id, wa_id), so one person messaging two businesses is two
-- contact rows and two separate memories, and there is no join that could merge
-- them by accident. The organization_id column below is redundant with that —
-- it is kept anyway so the row is tenant-scoped in its own right, RLS applies to
-- it directly, and a future query cannot reach it without a tenant context.
--
-- RETENTION IS NOT DEFERRED. Memory of a customer is exactly the sort of thing
-- that quietly accumulates for years, so `expires_at` is set on write and stale
-- rows are purged rather than kept "just in case".
-- ============================================================

create table if not exists contact_memory (
  organization_id   uuid not null references organizations(id) on delete cascade,
  contact_id        uuid not null references contacts(id) on delete cascade,

  -- Written by the summariser, read into the agent prompt. Prose about a real
  -- customer, so it is tenant-scoped and never crosses a boundary — it is not
  -- on the SHAREABLE allow-list and must never be.
  summary           text not null,

  -- What it was built from, so a thin memory is visibly thin rather than
  -- silently confident.
  source_messages   integer not null default 0,
  last_seen_at      timestamptz,

  updated_at        timestamptz not null default now(),
  -- Six months. Long enough to recognise a returning customer, short enough
  -- that we are not holding a behavioural profile indefinitely.
  expires_at        timestamptz not null default now() + interval '180 days',

  primary key (organization_id, contact_id)
);

create index if not exists idx_contact_memory_expiry on contact_memory (expires_at);

-- Purge on every deploy as well as on the schedule, so an expired row cannot
-- survive simply because the worker was down when it lapsed.
delete from contact_memory where expires_at < now();

do $$
declare
  n integer;
begin
  select count(*) into n from contact_memory;
  raise notice 'Contact memory ready: % live memories', n;
end $$;
