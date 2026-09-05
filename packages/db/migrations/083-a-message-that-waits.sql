-- ============================================================
-- Scheduled messages
-- ============================================================
--
-- A reply a colleague writes now and the platform sends later — "message them at
-- 9am tomorrow". It is the one inbox feature that acts on a customer with no
-- human at the moment of sending, so it is built to be visible and reversible:
-- every pending send is listed on its conversation and can be cancelled until it
-- fires, and a send that Meta refuses (outside the 24-hour window, say) is
-- marked failed with the reason rather than retried into a wall.
--
-- status walks pending → sending → sent | failed, and pending → cancelled. The
-- 'sending' state is the claim a sweep takes so two overlapping sweeps cannot
-- send the same row twice (see the processor's `for update skip locked`).

create table if not exists scheduled_messages (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  conversation_id  uuid not null references conversations(id) on delete cascade,
  contact_id       uuid not null references contacts(id) on delete cascade,

  body             text not null,
  send_at          timestamptz not null,

  status           text not null default 'pending'
                   check (status in ('pending', 'sending', 'sent', 'failed', 'cancelled')),

  -- Who scheduled it (a session subject), and what came back when it fired.
  created_by       text,
  wa_message_id    text,
  error            text,

  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);

-- The sweep's query: the soonest pending sends that are now due. Partial so the
-- index stays small — sent/failed/cancelled rows never sit in it.
create index if not exists idx_scheduled_due
  on scheduled_messages (send_at) where status = 'pending';
create index if not exists idx_scheduled_conversation
  on scheduled_messages (conversation_id);

-- The same tenant policy every other customer-facing table carries.
alter table scheduled_messages enable row level security;
drop policy if exists scheduled_messages_tenant_isolation on scheduled_messages;
create policy scheduled_messages_tenant_isolation on scheduled_messages
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
  select relrowsecurity into guarded from pg_class where relname = 'scheduled_messages';
  if not coalesce(guarded, false) then
    raise exception 'scheduled_messages was created without row-level security — it sends to customers';
  end if;
  raise notice 'scheduled_messages ready, tenant-isolated';
end $$;
