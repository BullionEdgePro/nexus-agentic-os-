-- ============================================================
-- Migration 032 — Let the businesses that book also check the diary
-- ============================================================
--
-- `book_appointment` stopped being a stub in this change: it now writes a real
-- row and is refused by a real constraint. That only works if the agent is
-- offering times somebody actually works, which is what `check_availability`
-- computes — from staff working hours and the existing diary, not from the
-- model's guess about a business's opening times.
--
-- Without this migration the new tool exists in the registry and is offered to
-- nobody, because `agent_configs.tools` is the allowlist and it still names one
-- tool. The agent would then be told to call check_availability first by
-- book_appointment's own description, find no such tool, and either invent a
-- time or give up. Both are worse than the stub it replaces.
--
-- ------------------------------------------------------------
-- Why this is not a list of slugs
-- ------------------------------------------------------------
--
-- The obvious version named the four businesses whose enquiries end in an
-- appointment — attestation, legal consultations, property viewings, case
-- consultations. It was written that way first, and it would have failed on
-- production.
--
-- `atif-ali-production` was replaced by ABR in migration 014, which deactivated
-- the organization and its agent_config rather than deleting either, so history
-- stayed attributed. That config still holds `["book_appointment",
-- "search_knowledge"]`. A slug list would have skipped it, the guard below would
-- have found a config that can book and cannot check, and the migration would
-- have raised — stopping a deploy over a business that has not answered a
-- message since August.
--
-- So the rule is applied to what the data says rather than to a list somebody
-- maintains: EVERY config that can book gains the ability to check. That is the
-- invariant the guard actually asserts, and a migration whose update and whose
-- guard disagree about their subject is a migration that fails on the row
-- nobody remembered. Zipicka is untouched for free — it is retail, it has
-- `check_inventory` and no `book_appointment`, so it matches nothing here.

update agent_configs
   set tools = (
         select jsonb_agg(distinct value)
           from jsonb_array_elements(tools || '["check_availability"]'::jsonb)
       )
 where tools ? 'book_appointment'
   and not (tools ? 'check_availability');

-- ------------------------------------------------------------
-- Guard: refuse to leave the two tools out of step
-- ------------------------------------------------------------
--
-- The failure this catches is the one this codebase keeps producing: not an
-- error, a plausible-looking wrong state. A config holding `book_appointment`
-- without `check_availability` produces an agent that books — confidently, and
-- at times nobody is working, because the only tool it has takes a datetime and
-- writes it down. That reads as a working feature until a customer arrives at a
-- locked door.
--
-- Deliberately NOT limited to active configs. A deactivated business can be
-- reactivated, and it would come back holding whatever tools it was left with.
do $$
declare
  orphaned text;
begin
  select string_agg(o.slug, ', ')
    into orphaned
    from agent_configs ac
    join organizations o on o.id = ac.organization_id
   where ac.tools ? 'book_appointment'
     and not (ac.tools ? 'check_availability');

  if orphaned is not null then
    raise exception
      'These businesses can book but cannot check availability: %. '
      'They would offer appointments outside working hours.',
      orphaned;
  end if;

  raise notice 'Every agent that books can also check the diary.';
end $$;
