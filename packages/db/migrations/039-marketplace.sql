-- F13, the marketplace: a catalogue a business installs FROM, never publishes TO.
--
-- The egress policy was decided on 2026-08-15 and it is the whole design:
-- NOTHING LEAVES. A business installs a template, a procedure or a knowledge
-- pack. It never contributes one. Publishing is authoring — done by whoever
-- runs the platform — not sharing.
--
-- WHY THAT IS ENFORCED BY THE SHAPE OF THESE TABLES, NOT BY A RULE
--
-- `catalog_items` has NO organization_id and no foreign key to any tenant
-- table. It cannot reference a business, a contact, a conversation or a
-- procedure belonging to anyone. There is no column in which one business's
-- material could be recorded, so no code path can put it there and no future
-- change can forget the rule — the same property that makes F5's shared store
-- safe, where the columns hold counts and category labels and a customer's
-- affairs have nowhere to go.
--
-- This matters more here than anywhere else in the platform. Juris Prime Legal
-- and ABR are both law firms answering on the same number. A marketplace able
-- to carry one firm's method to the other is not this feature with a risk
-- attached; it is a different product.
--
-- The install side IS tenant-scoped, because which packs a business has chosen
-- is that business's own information.

create table if not exists catalog_items (
  id uuid primary key default gen_random_uuid(),

  -- Stable across versions and safe to put in a URL or a support conversation.
  slug text not null unique,

  kind text not null check (kind in ('template', 'procedure', 'knowledge_pack')),
  title text not null,
  summary text not null,

  -- The thing itself. Shape depends on kind: message body and variables for a
  -- template, an ordered step list for a procedure, documents for a pack.
  -- Authored content only — see the note above about what may not be in here.
  payload jsonb not null,

  -- Who it is for, so a law firm is not offered a retailer's stock enquiry pack.
  -- A NULL means "any business", which is the honest default for something
  -- generic like an out-of-hours reply.
  suits_industry text,
  language text not null default 'en',

  -- Bumped when payload changes. An installed business keeps what it installed
  -- until it chooses to take an update: a catalogue that edits itself inside
  -- somebody's live agent is a marketplace that changes what customers are told
  -- without anyone deciding to.
  version integer not null default 1,

  -- Unpublished items are drafts. Nothing unpublished may be installed.
  published_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_payload_is_object check (jsonb_typeof(payload) = 'object')
);

create index if not exists catalog_items_published_idx
  on catalog_items (kind, language) where published_at is not null;

-- What a business has taken, and what it did with it.
create table if not exists catalog_installs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  catalog_item_id uuid not null references catalog_items(id) on delete restrict,

  -- The version actually installed, copied rather than referenced. If the
  -- catalogue moves to v3, this row still records that this business is running
  -- v2 — otherwise "what is this agent doing" has no answer after an update.
  installed_version integer not null,

  -- Installing is not activating. A procedure arrives inactive and a person
  -- switches it on, exactly as F10 requires for one it inferred: material that
  -- enters the prompt for every future customer wants a human decision, whether
  -- the platform wrote it or the catalogue did.
  is_active boolean not null default false,

  installed_at timestamptz not null default now(),
  removed_at timestamptz,

  -- Reinstalling something removed is allowed; having it twice at once is not.
  constraint catalog_install_once unique (organization_id, catalog_item_id, installed_at)
);

create index if not exists catalog_installs_org_idx
  on catalog_installs (organization_id) where removed_at is null;

-- Isolation on the install side only. `catalog_items` is deliberately NOT
-- tenant-scoped and deliberately NOT in TENANT_SCOPED_TABLES: it is a shared
-- registry like `organizations`, and scoping a catalogue every business reads
-- to one business would be as circular as scoping the tenant registry.
alter table catalog_installs enable row level security;
drop policy if exists catalog_installs_tenant_isolation on catalog_installs;
create policy catalog_installs_tenant_isolation on catalog_installs
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- nexus_app may read the catalogue and record installs. It may NOT write
-- catalogue items: authoring is an operator action performed deliberately, not
-- something the application can do while answering a customer.
grant select on catalog_items to nexus_app;
grant select, insert, update on catalog_installs to nexus_app;

-- Nothing is published yet. Schema and the boundary first.
