-- Point every agent at an Anthropic model.
--
-- WHY THIS MIGRATION IS NOT OPTIONAL, AND WHY IT GOES FIRST.
--
-- `AnthropicDomainAgent` passes `agent_configs.model` straight to the Anthropic
-- Messages API. A row still holding "gemini-3.5-flash" does not degrade — it
-- 404s on every single message that tenant receives, because the id names a
-- model that vendor has never heard of. DEPLOY.md's rule applies exactly:
-- migration first when new code READS a column with new expectations.
--
-- The value is chosen per row rather than blanket-set. Whatever a tenant's
-- previous row said about how capable its agent should be is information, and
-- overwriting all five with one id would throw it away.
--
--   claude-sonnet-5   the default. Near-Opus quality on the reasoning these
--                     agents actually do, at Sonnet cost, and already this
--                     table's schema default.
--   claude-opus-5     nothing is set to this here. It is the right answer for
--                     a tenant whose replies carry real liability, and that is
--                     a decision with a cost attached — it belongs to whoever
--                     pays the bill, not to a migration.
--
-- Gemini ids are matched by prefix rather than listed exactly. The deployment
-- has been through gemini-2.0-flash and gemini-3.5-flash already, and a match
-- list that has to be complete is a match list that misses the one nobody
-- remembered.

update agent_configs
   set model = 'claude-sonnet-5',
       updated_at = now()
 where model like 'gemini%'
    or model like 'models/gemini%';

-- Anything left naming a non-Anthropic model is a tenant this migration did not
-- anticipate. Loud, because the failure it prevents is silent to everyone
-- except the customers of that one business.
do $$
declare
  stragglers text;
begin
  select string_agg(distinct model, ', ')
    into stragglers
    from agent_configs
   where is_active
     and model not like 'claude-%';

  if stragglers is not null then
    raise exception 'agent_configs still names non-Anthropic model(s): %. Every reply for those tenants would 404.', stragglers;
  end if;

  raise notice 'every active agent is on an Anthropic model';
end $$;

-- The schema default already says claude-sonnet-5, so a tenant onboarded after
-- this migration lands correct without anyone remembering to set it.
