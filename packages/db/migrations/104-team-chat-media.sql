-- ============================================================
-- Team chat: voice notes, photos, files, replies and reactions
-- ============================================================
--
-- 2 Nov 2026. Staff chat becomes a WhatsApp-style group: press-and-hold voice
-- notes, photos and documents, emoji reactions and replies. Spec:
-- docs/superpowers/specs/2026-11-02-staff-chat-whatsapp-design.md
--
-- The files themselves live here, beside the messages, rather than on a disk
-- or in a cloud bucket: the owner chose the database so that every file is
-- under the same tenant policy as the words around it and inside the same
-- nightly, restore-verified backup. Staff chat is small; if it ever is not,
-- the bytes can move without the screens noticing.
--
-- Idempotent like every migration here, and applied as the owner role before
-- the code that reads it is deployed.

create table if not exists team_files (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  thread_id        uuid not null references team_threads(id) on delete cascade,
  -- An employee id, or 'admin:<adminId>' for an admin (the same key as team_reads).
  uploader         text not null check (char_length(uploader) between 1 and 120),
  kind             text not null check (kind in ('voice', 'photo', 'file')),
  -- The type the server detected from the bytes, never the browser's claim.
  mime             text not null check (char_length(mime) between 1 and 120),
  name             text not null check (char_length(name) between 1 and 200),
  size             integer not null check (size between 1 and 16777216),
  -- Null once its message is removed: a removed file cannot be fetched again.
  bytes            bytea,
  preview          bytea,
  width            integer check (width between 1 and 20000),
  height           integer check (height between 1 and 20000),
  duration_ms      integer check (duration_ms between 1000 and 305000),
  waveform         smallint[] check (waveform is null or cardinality(waveform) <= 128),
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index if not exists idx_team_files_thread on team_files (thread_id);

alter table team_files enable row level security;
drop policy if exists team_files_tenant_isolation on team_files;
create policy team_files_tenant_isolation on team_files
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update, delete on team_files to nexus_app;

alter table team_messages add column if not exists file_id uuid references team_files(id) on delete set null;
alter table team_messages add column if not exists reply_to uuid references team_messages(id) on delete set null;

-- A message may now be only a photo, a voice note or a file: its words can be
-- empty when something is attached. 101 declared the old check inline, so it
-- carries Postgres's default name.
alter table team_messages drop constraint if exists team_messages_body_check;
alter table team_messages drop constraint if exists team_messages_body_length;
alter table team_messages add constraint team_messages_body_length
  check (char_length(body) between 1 and 4000 or (file_id is not null and char_length(body) <= 4000));

create table if not exists team_reactions (
  message_id       uuid not null references team_messages(id) on delete cascade,
  organization_id  uuid not null references organizations(id) on delete cascade,
  -- An employee id, or 'admin:<adminId>'. One reaction per person per message.
  reactor          text not null check (char_length(reactor) between 1 and 120),
  reactor_name     text not null check (char_length(reactor_name) between 1 and 120),
  emoji            text not null check (char_length(emoji) between 1 and 16),
  created_at       timestamptz not null default now(),
  primary key (message_id, reactor)
);
create index if not exists idx_team_reactions_message on team_reactions (message_id);

alter table team_reactions enable row level security;
drop policy if exists team_reactions_tenant_isolation on team_reactions;
create policy team_reactions_tenant_isolation on team_reactions
  using (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true) or current_setting('app.tenant_scope', true) = 'all');
grant select, insert, update, delete on team_reactions to nexus_app;
