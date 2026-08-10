-- Nexus Agentic OS — multi-tenant WhatsApp Business ecosystem schema.
-- Target: PostgreSQL 15+ (Supabase). Run top to bottom on a fresh database.
-- gen_random_uuid() is built into core since PG13, so no pgcrypto extension is required.

-- ============================================================
-- Tenancy
-- ============================================================

create table organizations (
  id                          uuid primary key default gen_random_uuid(),
  -- NOT constrained to a fixed list. Migration 002 dropped this CHECK in
  -- production once the platform could onboard tenants beyond the original
  -- five; leaving it here meant a fresh install silently reintroduced the cap,
  -- and adding ABR (migration 014) would have failed on a new environment.
  slug                        text not null unique,
  name                        text not null,
  -- NOT unique. Several businesses share one WhatsApp number (the switchboard,
  -- migrations 007-010); which of them owns a given conversation is decided by
  -- `is_number_owner` plus a deterministic ORDER BY, not by this column being
  -- distinct. It was `unique` originally, and migration 010 drops that on
  -- existing databases — keeping it here would have quietly reintroduced it on
  -- every fresh install.
  whatsapp_phone_number_id    text not null,
  whatsapp_business_account_id text not null,
  timezone                    text not null default 'Asia/Dubai',
  is_active                   boolean not null default true,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create table organization_users (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  auth_user_id    uuid not null, -- references Supabase auth.users(id)
  role            text not null default 'agent' check (role in ('owner', 'admin', 'agent', 'viewer')),
  created_at      timestamptz not null default now(),
  unique (organization_id, auth_user_id)
);

-- ============================================================
-- Contacts
-- ============================================================

create table contacts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references organizations(id) on delete cascade,
  wa_id               text not null, -- WhatsApp user id (phone in international format, no '+')
  display_name        text,
  locale              text,
  attributes          jsonb not null default '{}', -- freeform CRM fields (order history refs, license status, etc.)
  ai_paused_until     timestamptz, -- human-handoff pause window
  last_message_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (organization_id, wa_id)
);

create index idx_contacts_org on contacts(organization_id);
create index idx_contacts_last_message on contacts(organization_id, last_message_at desc);

-- ============================================================
-- Conversations & Messages
-- ============================================================

create table conversations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  contact_id        uuid not null references contacts(id) on delete cascade,
  status            text not null default 'open' check (status in ('open', 'pending', 'resolved', 'closed')),
  assigned_agent_id uuid, -- references agent_configs(id) when AI-owned, or organization_users via auth_user_id when human-owned
  is_human_handoff  boolean not null default false,
  opened_at         timestamptz not null default now(),
  closed_at         timestamptz
);

create index idx_conversations_org_status on conversations(organization_id, status);

create table messages (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references organizations(id) on delete cascade,
  conversation_id       uuid not null references conversations(id) on delete cascade,
  contact_id            uuid not null references contacts(id) on delete cascade,
  wa_message_id         text, -- Meta's message id, null for internal/system messages
  direction             text not null check (direction in ('inbound', 'outbound')),
  sender_type           text not null check (sender_type in ('contact', 'ai_agent', 'human_agent', 'system')),
  sender_id             text, -- agent_configs.id or organization_users.auth_user_id, depending on sender_type
  message_type          text not null default 'text', -- text, image, document, template, interactive, etc.
  body                  text,
  raw_payload           jsonb, -- full Meta payload for audit/debug
  status                text not null default 'sent' check (status in ('queued', 'sent', 'delivered', 'read', 'failed')),
  created_at            timestamptz not null default now()
);

create index idx_messages_conversation on messages(conversation_id, created_at);
create index idx_messages_org_created on messages(organization_id, created_at desc);
create unique index idx_messages_wa_message_id on messages(wa_message_id) where wa_message_id is not null;

-- ============================================================
-- Agent configuration (the Domain Agent swarm)
-- ============================================================

create table agent_configs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  name              text not null,
  system_prompt     text not null,
  model             text not null default 'claude-sonnet-5',
  tools             jsonb not null default '[]', -- array of function-calling tool names, e.g. ["check_inventory", "book_appointment"]
  rag_collection    text, -- pointer to the vector store / knowledge base namespace
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (organization_id, name)
);

-- ============================================================
-- Governance & analytics
-- ============================================================

create table ai_message_evaluations (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  message_id        uuid not null references messages(id) on delete cascade,
  pii_flagged       boolean not null default false,
  hallucination_risk text check (hallucination_risk in ('low', 'medium', 'high')),
  notes             text,
  evaluated_at      timestamptz not null default now()
);

create index idx_evaluations_org on ai_message_evaluations(organization_id);
create index idx_evaluations_flagged on ai_message_evaluations(organization_id) where pii_flagged;

create table conversation_metrics (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references organizations(id) on delete cascade,
  conversation_id       uuid not null references conversations(id) on delete cascade,
  intent                text,
  resolved_by           text check (resolved_by in ('ai_agent', 'human_agent', 'unresolved')),
  input_tokens          integer not null default 0,
  output_tokens         integer not null default 0,
  first_response_ms     integer,
  resolution_ms         integer,
  recorded_at           timestamptz not null default now()
);

create index idx_metrics_org_recorded on conversation_metrics(organization_id, recorded_at desc);

-- ============================================================
-- Broadcasting & automation
-- ============================================================

create table message_templates (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  meta_template_name text not null,
  language          text not null default 'en',
  category          text,
  is_approved       boolean not null default false,
  created_at        timestamptz not null default now(),
  unique (organization_id, meta_template_name, language)
);

create table broadcasts (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references organizations(id) on delete cascade,
  template_id       uuid not null references message_templates(id),
  audience_filter   jsonb not null default '{}', -- segment definition over contacts.attributes
  status            text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'completed', 'failed')),
  scheduled_at      timestamptz,
  created_at        timestamptz not null default now()
);

create table broadcast_recipients (
  id            uuid primary key default gen_random_uuid(),
  broadcast_id  uuid not null references broadcasts(id) on delete cascade,
  contact_id    uuid not null references contacts(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'sent', 'delivered', 'failed')),
  sent_at       timestamptz,
  unique (broadcast_id, contact_id)
);

-- ============================================================
-- updated_at triggers
-- ============================================================

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_organizations_updated_at before update on organizations
  for each row execute function set_updated_at();
create trigger trg_contacts_updated_at before update on contacts
  for each row execute function set_updated_at();
create trigger trg_agent_configs_updated_at before update on agent_configs
  for each row execute function set_updated_at();
