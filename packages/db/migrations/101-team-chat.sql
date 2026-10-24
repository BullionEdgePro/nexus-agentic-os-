-- ============================================================
-- Team chat
-- ============================================================
--
-- 24 Oct 2026. Staff of one business talk to each other: one team room per
-- business and private 1-to-1 chats between two colleagues of that business.
-- The admin reads all of it and may post in the rooms. Spec:
-- docs/superpowers/specs/2026-10-24-team-chat-design.md
--
-- Every table carries organization_id under the standard tenant policy, so a
-- query that forgets its business still cannot read another one's talk.
-- Applied as the owner role before the code that reads it is deployed.

create table if not exists team_threads (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  kind             text not null check (kind in ('room', 'direct')),
  member_a         uuid references employees(id) on delete cascade,
  member_b         uuid references employees(id) on delete cascade,
  created_at       timestamptz not null default now(),
  -- A room has no members listed (everyone active in the business is in it);
  -- a direct chat has exactly two different people, stored in one order.
  check (
    (kind = 'room' and member_a is null and member_b is null)
    or (kind = 'direct' and member_a is not null and member_b is not null and member_a < member_b)
  )
);
create unique index if not exists idx_team_threads_one_room
  on team_threads (organization_id) where kind = 'room';
create unique index if not exists idx_team_threads_one_pair
  on team_threads (organization_id, member_a, member_b) where kind = 'direct';

alter table team_threads enable row level security;
drop policy if exists team_threads_tenant_isolation on team_threads;
create policy team_threads_tenant_isolation on team_threads
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update, delete on team_threads to nexus_app;

create table if not exists team_messages (
  id                      uuid primary key default gen_random_uuid(),
  thread_id               uuid not null references team_threads(id) on delete cascade,
  organization_id         uuid not null references organizations(id) on delete cascade,
  author_employee_id      uuid references employees(id) on delete set null,
  -- Kept on the row: a colleague who leaves is still the person who said it.
  author_name             text not null check (char_length(author_name) between 1 and 120),
  author_is_admin         boolean not null default false,
  body                    text not null check (char_length(body) between 1 and 4000),
  -- Chosen by the sender's screen, so a send retried after a dropped
  -- connection lands once.
  client_id               text not null check (char_length(client_id) between 1 and 80),
  mentions                uuid[] not null default '{}',
  shared_conversation_id  uuid references conversations(id) on delete set null,
  created_at              timestamptz not null default now(),
  deleted_at              timestamptz,
  unique (thread_id, client_id)
);
create index if not exists idx_team_messages_thread on team_messages (thread_id, created_at desc);

alter table team_messages enable row level security;
drop policy if exists team_messages_tenant_isolation on team_messages;
create policy team_messages_tenant_isolation on team_messages
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update, delete on team_messages to nexus_app;

create table if not exists team_reads (
  thread_id        uuid not null references team_threads(id) on delete cascade,
  organization_id  uuid not null references organizations(id) on delete cascade,
  -- An employee id, or 'admin:<adminId>' for an admin.
  reader           text not null check (char_length(reader) between 1 and 120),
  last_read_at     timestamptz not null default now(),
  primary key (thread_id, reader)
);

alter table team_reads enable row level security;
drop policy if exists team_reads_tenant_isolation on team_reads;
create policy team_reads_tenant_isolation on team_reads
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update, delete on team_reads to nexus_app;
