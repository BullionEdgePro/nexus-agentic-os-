-- ============================================================
-- 034 — F10: what a procedure has to survive before it speaks
-- ============================================================
--
-- Migration 033 built the boundary: procedures are tenant-scoped prose, RLS on,
-- inactive by default, nothing writing to them. This adds the columns the two
-- halves that follow need — the inference writer, and the screen a person
-- reviews its output on.
--
-- Everything here exists to answer one question the original table could not:
-- WHAT HAPPENS ON THE SECOND RUN.
--
-- ------------------------------------------------------------
-- An active procedure must not change under the business
-- ------------------------------------------------------------
--
-- The writer runs nightly. If it simply overwrote `steps`, then a procedure a
-- person read, judged and switched on would be quietly replaced by a later
-- inference — and the agent would start answering a different way, with nothing
-- on the screen saying so and nobody having agreed to it. The row would still
-- read as "reviewed and approved" because `is_active` is still true.
--
-- So an active procedure's `steps` are frozen against the writer. A newer
-- inference lands in `proposed_steps` instead, where it is a suggestion a human
-- can accept or dismiss. `steps` is what the agent uses; `proposed_steps` is
-- what the system would like it to be. Two columns, because those are two
-- different facts and one column could only hold whichever was written last.
--
-- ------------------------------------------------------------
-- A rejected suggestion must not come back tomorrow
-- ------------------------------------------------------------
--
-- The operator deck learned this the hard way in migration 027: a list that can
-- only ever grow gets ignored within a week, and an ignored list is
-- indistinguishable from no list while still looking like a working feature.
--
-- A nightly writer that re-proposes exactly what a person rejected yesterday is
-- the same failure wearing a different hat. `dismissed_at` records the refusal
-- and `dismissed_evidence` records how much evidence existed at the time, so
-- the writer can stay quiet until the evidence has genuinely moved — see
-- MIN_EVIDENCE_GROWTH_AFTER_DISMISSAL in the writer. Storing the count rather
-- than only the timestamp is the point: "it has been a while" is not new
-- information, and time alone would bring the same rejected draft back on a
-- schedule.
--
-- ------------------------------------------------------------
-- One inferred row per situation
-- ------------------------------------------------------------
--
-- 033 already allows only one ACTIVE procedure per (business, intent,
-- language), because two active procedures for one situation is a coin toss the
-- customer cannot see. The same argument applies one step earlier: sixty
-- inactive drafts for "appointment_booking", one per nightly run, is a review
-- queue nobody will read. The writer therefore updates one row per situation,
-- and the index below is what makes that true even if two runs ever overlap.
--
-- Deliberately scoped to `source = 'inferred'`. A procedure a person wrote is
-- theirs and may coexist with a suggestion — that is exactly the case where the
-- machine keeps having ideas and the human keeps their answer.

alter table procedures add column if not exists proposed_steps jsonb;
alter table procedures add column if not exists proposed_at timestamptz;
alter table procedures add column if not exists last_inferred_at timestamptz;
alter table procedures add column if not exists dismissed_at timestamptz;
alter table procedures add column if not exists dismissed_evidence integer;

-- Who turned this on, and when. Not audit theatre: 033's whole restraint is
-- that "an inferred procedure must be switched on by someone who knows the
-- business", and a claim nobody signed is a claim nobody made. Stored as the
-- session subject (an operator email or an employee code) rather than a foreign
-- key, because the two kinds of reviewer live in different tables and a nullable
-- pair of columns would let a row point at neither while looking complete.
alter table procedures add column if not exists reviewed_at timestamptz;
alter table procedures add column if not exists reviewed_by text;

create unique index if not exists procedures_one_inferred_per_intent
  on procedures (organization_id, intent_category, language)
  where source = 'inferred';

-- A procedure is an ordered list a person can hold in their head. Eight steps
-- is already generous; thirty is a transcript that has been mistaken for a
-- method, and it would crowd the retrieved knowledge out of the agent's prompt
-- the moment it went active. Enforced here rather than in the writer because
-- the route accepts hand-typed steps too, and a rule with two enforcement sites
-- has one that will be forgotten.
alter table procedures drop constraint if exists procedures_steps_bounded;
alter table procedures add constraint procedures_steps_bounded
  check (jsonb_array_length(steps) between 1 and 8);

alter table procedures drop constraint if exists procedures_proposed_steps_shape;
alter table procedures add constraint procedures_proposed_steps_shape
  check (
    proposed_steps is null
    or (jsonb_typeof(proposed_steps) = 'array'
        and jsonb_array_length(proposed_steps) between 1 and 8)
  );

-- A proposal with no date, or a date with no proposal, is a half-written state
-- the screen would have to guess about. Guaranteed as a pair.
alter table procedures drop constraint if exists procedures_proposed_pairing;
alter table procedures add constraint procedures_proposed_pairing
  check ((proposed_steps is null) = (proposed_at is null));

-- No DELETE grant, matching 033 and for the same reason follow-ups cannot be
-- deleted: a procedure that was once active is the record of how this business
-- answered its customers for a while. Dismissing and deactivating both keep it.

do $$
declare
  missing text;
begin
  select string_agg(needed, ', ')
    into missing
    from unnest(array[
      'proposed_steps', 'proposed_at', 'last_inferred_at',
      'dismissed_at', 'dismissed_evidence', 'reviewed_at', 'reviewed_by'
    ]) as needed
   where not exists (
     select 1 from information_schema.columns
      where table_name = 'procedures' and column_name = needed
   );

  if missing is not null then
    raise exception 'procedures is missing %', missing;
  end if;

  if not exists (
    select 1 from pg_indexes
     where tablename = 'procedures' and indexname = 'procedures_one_inferred_per_intent'
  ) then
    raise exception 'the one-inferred-row-per-situation index was not created';
  end if;

  raise notice 'F10: a procedure can now be proposed, reviewed and refused.';
end $$;
