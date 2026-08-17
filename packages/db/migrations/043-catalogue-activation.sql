-- Activation: turning an installed pack into the business's own material.
--
-- Installing recorded a decision. Activating is what makes it real, and it is
-- the larger half — material that enters the prompt for every future customer.
--
-- WHAT ACTIVATION MEANS HERE, precisely: it MATERIALISES, it does not switch on.
-- A catalogue procedure becomes a `procedures` row for that business with
-- `is_active = false`, and a person turns it on from "How we answer" — the
-- screen that already exists for exactly that decision, already shows what else
-- is active for the same situation, and already refuses two at once. Sending a
-- catalogue click straight into the live prompt would be the one thing 039's
-- whole design says must not happen, and would duplicate a review surface that
-- was built and tested for this.
--
-- ============================================================
-- A third source, because the two we had are both lies here
-- ============================================================
--
-- 033 drew the line between a procedure a person gave the system ('operator',
-- authoritative) and one the system inferred from this business's own
-- conversations ('inferred', a suggestion). A catalogue procedure is neither.
-- Nobody at this business wrote it, and it was not drawn from a single
-- conversation this business has had.
--
-- Labelling it 'inferred' would be the worse lie: the review screen would say
-- "drawn from 0 conversations", which is evidence that does not exist, and the
-- nightly writer would treat it as its own draft and rewrite it.
--
-- Labelling it 'operator' is the safer lie and still a lie. The review screen
-- says "written here". Worse, F10's rule 3 makes the writer go PERMANENTLY
-- SILENT for any situation where an operator procedure is active — so a generic
-- pack somebody installed in a minute would switch off this business's learning
-- about that kind of enquiry, for good, and nothing would say so.
--
-- So: 'catalog'. And note what follows from it, which is the point of the
-- distinction rather than a side effect — THE WRITER DOES NOT DEFER TO IT.
-- `upsertInferredProcedure` looks for `source = 'operator' and is_active`, which
-- a catalogue row is not, so the writer keeps proposing drafts drawn from this
-- business's real conversations. That is the behaviour we want: a generic pack
-- is a starting point, evidence about how this business actually works is more
-- specific than it, and the person is the one who chooses between them. When
-- they try, `procedures_one_active_per_intent` refuses the second activation
-- with a sentence they can act on in one click.
--
-- Neither existing unique index is disturbed, and both were checked rather than
-- assumed: `procedures_one_active_per_intent` is partial on `is_active`, so a
-- catalogue row competes for the single active slot exactly as it should;
-- `procedures_one_inferred_per_intent` (034) is partial on `source = 'inferred'`,
-- so a catalogue row does not occupy the writer's slot and the nightly run can
-- still insert its own draft alongside.

alter table procedures drop constraint if exists procedures_source_check;
alter table procedures add constraint procedures_source_check
  check (source in ('operator', 'inferred', 'catalog'));

-- ============================================================
-- The link back
-- ============================================================
--
-- Which install produced this row. Nullable, because almost every procedure has
-- no catalogue behind it.
--
-- `on delete set null` rather than cascade: if an install row were ever removed,
-- the procedure it produced belongs to the business and must not vanish with
-- it. The provenance is lost; the material is not. (Nothing deletes installs
-- today — 042 revoked that — so this is the answer to a question that should
-- stay hypothetical.)
alter table procedures add column if not exists catalog_install_id uuid
  references catalog_installs(id) on delete set null;

-- Activating twice must not produce two copies of the same procedure. This is
-- the constraint that makes `activateInstall` idempotent, rather than a
-- read-then-write in the application that two clicks could interleave — the
-- same argument as 040, one table over.
create unique index if not exists procedures_one_per_catalog_install
  on procedures (catalog_install_id)
  where catalog_install_id is not null;

-- The application activates on an operator's instruction, so it writes these.
-- It still holds no delete on procedures (034), which is why activation
-- withdraws nothing: see the note in routes/catalog.ts about why taking
-- material back out belongs to the screens that own it.
