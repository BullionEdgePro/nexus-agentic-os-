-- Campaigns for everybody, with no ceiling this platform invented.
--
-- ============================================================
-- WHAT THE OWNER ASKED FOR, AND WHY IT IS REASONABLE
-- ============================================================
--
-- Migration 073 shipped campaigns switched off per person with a 200-a-month
-- ceiling, and argued for both: a staff campaign spends the shared number's
-- standing with WhatsApp, and that standing is what all six businesses depend
-- on to get their ordinary replies delivered.
--
-- The owner has heard that argument and decided otherwise: every staff member
-- may send, new hires included, with no monthly limit. That is their call to
-- make — it is their number, their customers and their reputation, and a
-- default I chose is not a rule they have to live under.
--
-- ============================================================
-- BUT "NO LIMIT" WAS NEVER TRUE, AND PRETENDING IT IS WOULD BE WORSE
-- ============================================================
--
-- Meta caps this number at its messaging tier — 250 unique customers in any
-- rolling 24 hours while the business remains unverified, shared across every
-- business on the number. Removing OUR ceiling does not remove THAT one. It
-- only removes the thing that used to refuse a campaign before it ran into it.
--
-- So the ceiling is not replaced with a bigger number. It is replaced with the
-- REAL one, reported rather than enforced: the campaign screen states how many
-- new conversations the number can still start today, and the confirmation says
-- plainly when a campaign is larger than that. The sender decides. What they
-- must not do is find out afterwards, from a delivery report, that a third of
-- their list silently never arrived.
--
-- ============================================================
-- NULL, NOT A LARGE NUMBER
-- ============================================================
--
-- The tempting version sets every cap to 10000 and calls it unlimited. That
-- leaves a number in the column that is not a policy anybody chose, which the
-- screen then prints — "9,847 of 10,000 left this month" is a sentence nobody
-- meant to write, and the day somebody legitimately needs 10,001 it fails for a
-- reason that exists nowhere except in a forgotten migration.
--
-- NULL means no ceiling. It reads as absence in the column, in the code and on
-- the screen, which is what it is.

alter table employees
  alter column broadcast_monthly_cap drop not null,
  alter column broadcast_monthly_cap drop default;

comment on column employees.broadcast_monthly_cap is
  'Recipients per calendar month for this person. NULL means no ceiling set by this platform — '
  'which is not the same as unlimited: Meta''s messaging tier still applies to the number.';

-- The constraint has to tolerate NULL. Kept for the case where somebody DOES
-- set a ceiling, so a typo of 100000 is still refused.
alter table employees drop constraint if exists employees_broadcast_cap_check;
alter table employees
  add constraint employees_broadcast_cap_check
  check (broadcast_monthly_cap is null
         or (broadcast_monthly_cap >= 0 and broadcast_monthly_cap <= 100000));

-- New staff can send from their first day, per the owner's instruction.
alter table employees alter column can_broadcast set default true;

comment on column employees.can_broadcast is
  'Whether this person may send campaigns. Default true since 2026-08-29 at the owner''s instruction — '
  'previously off, on the argument that a staff campaign spends the shared number''s quality rating.';

-- Everybody who already exists, brought to the same footing as everybody who
-- will. A default only helps the next person.
update employees
   set can_broadcast = true,
       broadcast_monthly_cap = null
 where is_active;
