-- Re-engagement: reaching back to a lead who went quiet.
--
-- Every other feature in this platform waits to be spoken to. This one speaks
-- first, which makes it the only feature that can annoy someone who never asked
-- to hear from us — and the only one where a bug costs the business its WhatsApp
-- quality rating rather than a confused reply.
--
-- Zipicka had 13 conversations in 60 days. At that volume converting one more
-- contact matters more than any dashboard, which is why this is worth building.
-- It is also why it must be conservative: a business with 13 conversations
-- cannot afford to burn any of them.
--
-- THE COOLDOWN IS ENFORCED HERE, NOT IN APPLICATION CODE.
--
-- The obvious implementation — look up when we last messaged this contact, and
-- skip if it was recent — is the same race that would have double-booked an
-- employee. Two workers, a retry, or a scheduler firing twice all read "no
-- recent attempt" at the same moment and both send. The customer gets two
-- identical nudges, nothing errors, and the only record is in WhatsApp.
--
-- So the gap between attempts is an exclusion constraint. Postgres refuses the
-- second insert regardless of timing, and the sender treats that refusal as
-- "already handled" rather than as an error.
create extension if not exists btree_gist;

create table if not exists reengagement_attempts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,

  -- The approved template used. Recorded per attempt because a template can be
  -- edited or retired at Meta, and "what did we actually send this person" must
  -- survive that.
  template_name text not null,

  -- What prompted it, kept so a human can judge whether the nudge was fair.
  reason text,
  lead_score integer,

  sent_at timestamptz not null default now(),

  -- When this contact becomes reachable again.
  --
  -- Stored rather than computed, because the obvious form —
  -- `tstzrange(sent_at, sent_at + interval '30 days')` inside the constraint —
  -- is rejected: `timestamptz + interval` is STABLE, not IMMUTABLE, and an
  -- exclusion constraint may only index immutable expressions. A range over two
  -- plain columns is immutable, so the window becomes a column and the default
  -- supplies the 30 days.
  cooldown_until timestamptz not null default now() + interval '30 days',

  -- Did it work? Set when the contact replies. Not a guess: 'replied' means a
  -- real inbound message arrived after sent_at.
  outcome text not null default 'sent'
    check (outcome in ('sent', 'replied', 'failed', 'opted_out')),
  responded_at timestamptz,

  created_at timestamptz not null default now(),

  constraint reengagement_responded_after_sent
    check (responded_at is null or responded_at >= sent_at)
);

-- At most one attempt per contact in any 30-day window.
--
-- 30 days is deliberately long. This is a business with a handful of
-- conversations a month reaching people who did not ask to be contacted again;
-- the cost of nudging too often is a block or a quality-rating cut, and both are
-- far more expensive than a lead that goes cold. Widening this is a decision
-- someone should have to make on purpose.
-- The first run of this migration created the table and then failed on the
-- constraint below, so production briefly held the table WITHOUT its cooldown.
-- This makes the column addition re-runnable rather than assuming a clean slate.
alter table reengagement_attempts
  add column if not exists cooldown_until timestamptz not null default now() + interval '30 days';

alter table reengagement_attempts drop constraint if exists reengagement_one_per_month;
alter table reengagement_attempts add constraint reengagement_one_per_month
  exclude using gist (
    contact_id with =,
    tstzrange(sent_at, cooldown_until) with &&
  );

create index if not exists reengagement_org_sent_idx
  on reengagement_attempts (organization_id, sent_at desc);
create index if not exists reengagement_contact_idx
  on reengagement_attempts (contact_id, sent_at desc);

-- Someone who asks to be left alone must never be contacted again, and that has
-- to outlive any individual attempt row. A flag on the contact is the only place
-- it cannot be lost by a cleanup of old attempts.
alter table contacts add column if not exists reengagement_opted_out boolean not null default false;

alter table reengagement_attempts enable row level security;
drop policy if exists reengagement_tenant_isolation on reengagement_attempts;
create policy reengagement_tenant_isolation on reengagement_attempts
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

grant select, insert, update on reengagement_attempts to nexus_app;

-- Nothing sends yet. Schema, cooldown and opt-out first, deliberately, so the
-- restraints exist before anything can reach a customer.
