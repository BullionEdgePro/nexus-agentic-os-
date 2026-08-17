-- A home for authored agent wording, which this platform already had and had
-- nowhere to put.
--
-- WHAT WAS ACTUALLY WRONG. Two string constants live in the reply processor:
--
--   FALLBACK_REPLY          "…I'm looping in a specialist from our team."
--   FALLBACK_REPLY_NO_STAFF "…Could you tell me a little more about what you need…"
--
-- They are sent by three call sites — governance escalation, the AI-failure
-- path, and the handover flag — so they are among the most-delivered sentences
-- on the platform. And they are IDENTICAL for a retailer and two law firms.
-- "I'm looping in a specialist from our team" is a reasonable thing for Zipicka
-- to say and a strange thing for ABR Advocates to say, and changing either has
-- always required a code change and a deploy.
--
-- That is the gap the F13 template refusal was really pointing at. There was no
-- table for authored wording, so the catalogue could not install any — and the
-- nearest thing, appending prose to `agent_configs.system_prompt`, is one
-- unstructured blob per business with no provenance and no way to take anything
-- back out.
--
-- ============================================================
-- WHY THIS TABLE IS MORE DANGEROUS THAN `procedures`, AND SHAPED FOR IT
-- ============================================================
--
-- A procedure is CONTEXT. It enters the prompt as an assistant note, the model
-- reads it, and a bad one produces a slightly wrong shape of reply. A phrase is
-- THE MESSAGE. It is sent verbatim, with no model between it and the customer,
-- at the exact moment the platform has decided it cannot answer properly. There
-- is nothing downstream to catch a mistake in it.
--
-- Three consequences, all of them in the schema rather than in a rule:
--
--   1. Nothing arrives switched on. Same as 033 and the same reason, only more
--      so.
--
--   2. One active phrase per (business, moment, language), enforced by a partial
--      unique index. Two candidate sentences for one moment is a coin toss the
--      customer cannot see — 033's own words about procedures, and truer here.
--
--   3. Length is bounded IN THE DATABASE, not only in the form. A phrase is
--      delivered as written; a 4000-character one is delivered as a
--      4000-character WhatsApp message.
--
-- The unfilled-placeholder guard — a phrase containing `{{open_time}}` may not
-- be switched on — lives in application code rather than a check constraint,
-- deliberately: a business may legitimately DRAFT one with placeholders while
-- filling them in, and a constraint would refuse the draft as well as the
-- activation. The rule that matters is "cannot go live", not "cannot exist".

create table if not exists agent_phrases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,

  -- One of PHRASE_MOMENTS in packages/shared/src/phrases.ts. Constrained here
  -- as well as there, because this column decides which hardcoded default a row
  -- replaces — a typo'd moment is a phrase that is stored, visible, switched
  -- on, and never sent.
  moment text not null check (moment in ('handing_over', 'no_one_available')),
  language text not null default 'en',

  -- Sent verbatim. See the note above about what that means.
  body text not null,

  -- 'operator' — somebody at or for this business wrote it.
  -- 'catalog'  — it arrived from the marketplace. Same three-way distinction as
  --              procedures (043), for the same reason: neither of the other
  --              two labels would be true of it.
  source text not null default 'operator' check (source in ('operator', 'catalog')),
  catalog_install_id uuid references catalog_installs(id) on delete set null,

  is_active boolean not null default false,

  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint agent_phrase_length check (char_length(body) between 20 and 600)
);

create unique index if not exists agent_phrases_one_active_per_moment
  on agent_phrases (organization_id, moment, language)
  where is_active;

create index if not exists agent_phrases_org_idx
  on agent_phrases (organization_id, moment);

-- Activating a catalogue template twice must not write two drafts. Same
-- argument as 043's index on procedures.
create unique index if not exists agent_phrases_one_per_catalog_install
  on agent_phrases (catalog_install_id)
  where catalog_install_id is not null;

alter table agent_phrases enable row level security;
drop policy if exists agent_phrases_tenant_isolation on agent_phrases;
create policy agent_phrases_tenant_isolation on agent_phrases
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- REVOKE FIRST, THEN GRANT — the lesson 039 wrote down, 042 had to finish, and
-- this file applies from the start rather than after being caught. An earlier
-- blanket grant is still sitting on this schema, so a bare `grant select,
-- insert, update` would leave DELETE behind exactly as it did on
-- catalog_installs.
--
-- No delete: a phrase that was live is the record of what this business told
-- its customers for a while. Withdrawing one is `is_active = false`.
revoke all on agent_phrases from nexus_app;
grant select, insert, update on agent_phrases to nexus_app;
