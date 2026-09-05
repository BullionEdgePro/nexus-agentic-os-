-- ============================================================
-- The fields behind a contact's Details panel
-- ============================================================
--
-- The contacts table already carries most of what a details panel shows —
-- display_name, wa_id, created_at (first seen), reengagement_opted_out (opt-in),
-- owner_employee_id, and an AI lead_score/priority/category. This adds only the
-- three things a PERSON edits by hand and the table had no home for:
--
--   lead_stage    a MANUAL pipeline stage (New, Contacted, Qualified, Won...),
--                 kept separate from the AI-derived lead_* columns on purpose so
--                 a human's decision and the model's guess never overwrite each
--                 other. Free text, because a business's pipeline is its own.
--
--   notes         internal notes a colleague leaves on the customer — not the AI
--                 contact-memory (that is `attributes`/contact_memory and feeds
--                 the model), but a human note that no reply is ever built from.
--
--   custom_fields a bag the business fills with whatever it tracks, kept apart
--                 from `attributes` (which the system also writes) so a person's
--                 keys can never clobber a system one, and vice versa.
--
-- NOT NULL DEFAULT '{}' on the jsonb so it always reads as an object; the text
-- columns are nullable, where null honestly means "not set yet". Re-runnable.

alter table contacts
  add column if not exists lead_stage    text,
  add column if not exists notes         text,
  add column if not exists custom_fields jsonb not null default '{}';
