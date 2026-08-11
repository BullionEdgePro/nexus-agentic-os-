-- ============================================================
-- 024 — resolve the keyword collisions migration 023 surfaced
--
-- Thirteen keywords were claimed by two businesses. Each one routes to NEITHER:
-- the switchboard returns a triage menu instead. Most of them predate the
-- Arabic work — "lawyer", "court" and "case" have been shared by both law firms
-- since the switchboard shipped, so every such enquiry has been asking the
-- customer a question the data could have answered. Nothing reported it until
-- 023 audited itself.
--
-- THE BASIS FOR EACH DECISION IS EACH FIRM'S OWN STATED PRACTICE:
--
--   ABR Advocates & Legal Consultants — litigation and arbitration, criminal
--   defence, bail, appeals, cassation. A courtroom firm.
--
--   Juris Prime Legal — corporate services: company formation, freezone
--   licensing, powers of attorney, MOAs, wills, eviction.
--
--   SFS International — real estate.
--
-- So:
--
--   court, case, محكمة, قضية        → ABR. Juris Prime Legal does not litigate.
--   lawyer, lawyers, advocate,      → ABR. Someone asking for "a lawyer" wants
--   محامي, محاماة                      representation; the firm is literally
--                                     named Advocates. Juris Prime Legal's
--                                     clients ask about company setup.
--   landlord, ايجار                 → SFS. Juris Prime Legal keeps the precise
--                                     terms — eviction, إخلاء, عقد إيجار — so a
--                                     real dispute still reaches it, while a
--                                     landlord with a property reaches the
--                                     agency.
--
-- DELIBERATELY LEFT SHARED: "legal" and "قانوني".
--
-- Both firms are legal practices and the word is honest evidence for either.
-- Assigning it would be inventing a distinction the customer did not make, and
-- the switchboard asking "which of these?" is the correct answer to a genuinely
-- ambiguous message. Two shared keywords by choice is a different thing from
-- thirteen by accident.
--
-- REVERSIBLE. Every statement below removes a keyword from ONE business; the
-- terms all still exist on the other. If a decision here is wrong — and these
-- are judgements from published practice areas, not from watching real
-- enquiries — re-adding is a one-line update.
-- ============================================================

-- Litigation vocabulary belongs to the litigation firm.
update organizations
   set routing_keywords = (
     select array(
       select k from unnest(routing_keywords) k
        where k not in (
          'advocate', 'case', 'court', 'lawyer', 'lawyers',
          'قضية', 'محاماة', 'محامي', 'محكمة'
        )
     )
   )
 where slug = 'juris-prime-legal' and is_active;

-- Tenancy: the agency gets the general term, the firm keeps the dispute terms.
-- Both alef spellings are removed because the stored form may be either, and
-- normalizeForMatch folds them only at match time — not in the column.
update organizations
   set routing_keywords = (
     select array(
       select k from unnest(routing_keywords) k
        where k not in ('landlord', 'ايجار', 'إيجار')
     )
   )
 where slug = 'juris-prime-legal' and is_active;

do $$
declare
  r record;
  n integer := 0;
  abr_lawyer boolean;
begin
  -- Assert the terms survived on the business that should keep them. Removing
  -- from one side and finding the other never had it would leave the keyword
  -- routing nowhere at all — strictly worse than the collision it replaced.
  select 'محامي' = any(routing_keywords) and 'lawyer' = any(routing_keywords)
    into abr_lawyer
    from organizations where slug = 'abr' and is_active;

  if not coalesce(abr_lawyer, false) then
    raise exception 'ABR is missing lawyer/محامي — the terms were removed from one firm and exist on neither.';
  end if;

  for r in
    select lower(keyword) as keyword, array_agg(o.slug order by o.slug) as claimants
      from organizations o, unnest(o.routing_keywords) as keyword
     where o.is_active
     group by lower(keyword)
    having count(distinct o.slug) > 1
     order by 1
  loop
    n := n + 1;
    raise notice 'still shared: "%" — %', r.keyword, array_to_string(r.claimants, ', ');
  end loop;

  raise notice '% shared keyword(s) remain. Two are deliberate: legal and قانوني.', n;
end $$;
