-- ============================================================
-- The channel a conversation arrived on, and a place to log a call
-- ============================================================
--
-- A team inbox is multi-channel: the same customer might reach a business over
-- WhatsApp today and email tomorrow, and the people answering want one place
-- that shows both and says which is which. Until now every conversation on this
-- platform was WhatsApp, so there was nothing to say and nothing said it.
--
-- Two foundations here, both additive and safe to re-run:
--
--   1. conversations.channel — where a conversation came from. Defaults to
--      'whatsapp', so every existing row is already correct, and the inbox can
--      badge and filter by channel. This is the seam every other channel plugs
--      into: an email/sms/instagram conversation is the same row with a
--      different channel, answered through that channel's own adapter. WhatsApp
--      is the adapter that is live today; the rest are wired but dormant until
--      their provider credentials exist, so nothing here pretends to send over a
--      channel it cannot.
--
--   2. call_logs — a record that a phone call happened. Placing calls needs a
--      telephony provider nobody has connected yet, but a CRM still has to
--      remember that a customer was phoned, by whom, and how it went. Logged by
--      hand today; written by the provider automatically once one is wired in.
--      Kept in its own table rather than as a message, because a call is not a
--      message — it has a direction, an outcome and a duration, not a body.

-- --- 1. the channel a conversation is on -----------------------------------

alter table conversations
  add column if not exists channel text not null default 'whatsapp';

-- Only the handful the platform knows how to show; a typo should fail loudly
-- rather than become a channel nothing can render. Dropped first so re-running
-- with a widened set replaces the old constraint.
alter table conversations drop constraint if exists conversations_channel_known;
alter table conversations
  add constraint conversations_channel_known
  check (channel in ('whatsapp', 'email', 'sms', 'instagram', 'phone'));

-- --- 2. a call worth logging ------------------------------------------------

create table if not exists call_logs (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,

  -- The thread and customer this call belongs to. Both nullable: a cold call to
  -- a number that never opened a chat still deserves a record, and a thread can
  -- be deleted from under a call without erasing that the call happened.
  conversation_id  uuid references conversations(id) on delete set null,
  contact_id       uuid references contacts(id) on delete set null,

  -- Who rang whom, and how it went. Constrained to the outcomes a person picks
  -- from, so the column stays a fact and not a free-text muddle.
  direction        text not null check (direction in ('inbound', 'outbound')),
  outcome          text not null check (outcome in ('answered', 'no-answer', 'voicemail', 'busy', 'failed')),

  -- How long it lasted, if it connected, and anything the caller wants to keep.
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  notes            text,

  -- Who logged it (a session subject, for provenance only) and when the call was.
  logged_by        text,
  occurred_at      timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

create index if not exists idx_call_logs_conversation
  on call_logs (conversation_id, occurred_at desc);
create index if not exists idx_call_logs_org
  on call_logs (organization_id, occurred_at desc);

alter table call_logs enable row level security;
drop policy if exists call_logs_tenant_isolation on call_logs;
create policy call_logs_tenant_isolation on call_logs
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

grant select, insert, update, delete on call_logs to nexus_app;

do $$
declare
  guarded boolean;
begin
  select relrowsecurity into guarded from pg_class where relname = 'call_logs';
  if not coalesce(guarded, false) then
    raise exception 'call_logs was created without row-level security';
  end if;
  raise notice 'call_logs ready, tenant-isolated; conversations.channel added';
end $$;
