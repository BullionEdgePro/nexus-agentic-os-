-- The system prompt, editable by the business whose agent it is.
--
-- ============================================================
-- WHERE IT COULD BE CHANGED UNTIL NOW
-- ============================================================
--
-- One place: `onboardBusiness`, called from a CLI script, run by whoever has
-- SSH to the VPS. No route touched `agent_configs.system_prompt` and no screen
-- showed it.
--
-- That is the single most consequential setting in this product. It is what the
-- agent is TOLD TO BE, and it shapes every reply to every customer -- more than
-- the knowledge base, which only supplies facts, and more than the procedures,
-- which only apply to situations they match. A business that wanted its agent
-- to stop saying something had to ask somebody to run `npx tsx` inside a
-- container.
--
-- ============================================================
-- WHY HISTORY, AND NOT JUST AN EDIT
-- ============================================================
--
-- A bad prompt does not fail. It answers, plausibly, in a slightly wrong way,
-- to everyone, until somebody reads a transcript and notices -- which on this
-- platform's traffic could be weeks. Every other layer that shapes a reply has
-- a way back: a procedure is proposed and reviewed, a phrase is switched off, a
-- knowledge source is deleted and re-added.
--
-- The prompt had none, so an edit made at 2am was permanent unless the person
-- who made it happened to keep a copy. Every change now writes what was
-- replaced, with who did it, and reverting is picking a row.

create table if not exists agent_config_versions (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  agent_config_id  uuid not null references agent_configs(id) on delete cascade,

  -- The prompt AS IT WAS, not the change. A diff would need the previous row to
  -- reconstruct, and the row before it, and the point of this table is to be
  -- readable on the worst day rather than the tidiest.
  system_prompt    text not null,

  -- Who replaced it, and why if they said. Both nullable for the seed row
  -- written on the first edit, which records a state nobody in this table
  -- authored -- it came from onboarding.
  replaced_by      text,
  note             text,

  created_at       timestamptz not null default now()
);

create index if not exists idx_agent_config_versions_org
  on agent_config_versions (organization_id, created_at desc);

alter table agent_config_versions enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where tablename = 'agent_config_versions' and policyname = 'agent_config_versions_tenant_isolation') then
    create policy agent_config_versions_tenant_isolation on agent_config_versions
      using (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all')
      with check (organization_id::text = current_setting('app.current_org', true)
             or current_setting('app.tenant_scope', true) = 'all');
  end if;
end $$;

grant select, insert, update, delete on agent_config_versions to nexus_app;

-- Who last changed the live prompt, on the config itself, so the screen can say
-- it without reading the history. Null means nobody has edited it since
-- onboarding, which is a fact worth showing rather than a gap.
alter table agent_configs
  add column if not exists prompt_updated_by text,
  add column if not exists prompt_updated_at timestamptz;

comment on column agent_configs.prompt_updated_by is
  'Who last changed system_prompt through the product. Null means it is still as onboarding left it.';
