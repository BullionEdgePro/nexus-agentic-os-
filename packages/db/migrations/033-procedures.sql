-- F10, procedural memory: how a business does a thing, not what it knows.
--
-- The distinction from `knowledge_chunks` is worth stating, because they look
-- alike and are not. Knowledge answers "what is the fee for MOFA attestation".
-- A procedure answers "when someone asks for attestation, establish which
-- document, then which country, then quote, then offer a booking" — the order a
-- business works in, learned from conversations that ended well.
--
-- WHY THIS TABLE IS TENANT-SCOPED AND WILL NEVER BE SHARED
--
-- F5's shared store is safe by construction: its columns hold counts and
-- category labels, so there is physically nowhere to put a customer's affairs.
-- Procedures cannot be built that way. A procedure IS prose, and a law firm's
-- procedure encodes how that firm handles matters — which is the firm's method,
-- and sometimes a client's circumstances.
--
-- So the protection here is not a narrow schema; it is that these rows never
-- leave their business. `organization_id` is NOT NULL, RLS is on, and this
-- table is deliberately absent from every cross-tenant read path. Juris Prime
-- Legal and ABR are both law firms on the same number; one must never answer
-- from the other's method.
--
-- Nothing writes to this table yet. Schema and isolation first, deliberately,
-- so the boundary exists before anything can cross it.

create table if not exists procedures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,

  -- What situation this applies to. Matches the intent vocabulary already used
  -- by lead scoring and the shared-pattern rollup, so a procedure can be found
  -- by the same classification that routes the conversation.
  intent_category text not null,
  language text not null default 'en',

  -- The procedure itself: an ordered list of steps. jsonb rather than prose so
  -- a step can carry structure later (a tool to call, a field to collect)
  -- without a migration, and so the agent is handed a sequence rather than a
  -- paragraph it has to re-interpret every time.
  steps jsonb not null,

  -- Where it came from. A procedure written by an operator is authoritative; one
  -- inferred from conversations that resolved well is a suggestion. Conflating
  -- them would let a pattern the system invented outrank an instruction a person
  -- gave it.
  source text not null default 'inferred'
    check (source in ('operator', 'inferred')),

  -- Evidence, kept so a human can judge it. `times_applied` and
  -- `times_succeeded` are what make a procedure reviewable rather than a rule
  -- nobody can argue with — the same reason operator findings can be retracted.
  derived_from_count integer not null default 0,
  times_applied integer not null default 0,
  times_succeeded integer not null default 0,

  -- Off by default. An inferred procedure must be switched on by someone who
  -- knows the business before it shapes a single reply. This is the same
  -- restraint F14 applies to acting on quality metrics automatically: measuring
  -- is safe, acting is a judgement.
  is_active boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint procedures_steps_is_array check (jsonb_typeof(steps) = 'array'),
  constraint procedures_steps_not_empty check (jsonb_array_length(steps) > 0)
);

-- One active procedure per situation per language. Two active procedures for
-- the same intent is not a richer system; it is a coin toss the customer cannot
-- see, and the losing branch is invisible in every log.
create unique index if not exists procedures_one_active_per_intent
  on procedures (organization_id, intent_category, language)
  where is_active;

create index if not exists procedures_org_intent_idx
  on procedures (organization_id, intent_category);

alter table procedures enable row level security;
drop policy if exists procedures_tenant_isolation on procedures;
create policy procedures_tenant_isolation on procedures
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

grant select, insert, update on procedures to nexus_app;
