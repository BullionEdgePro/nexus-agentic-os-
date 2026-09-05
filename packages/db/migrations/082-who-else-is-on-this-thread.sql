-- ============================================================
-- Collaborators on a conversation
-- ============================================================
--
-- One conversation has one owner (employee_id) — the person it is assigned to.
-- Collaborators are the OTHERS a colleague pulls in to help on a specific
-- thread: a specialist, a manager, someone who knows this customer. It does not
-- change who owns the thread or who the twin stands down for; it is a "these
-- people are also watching this one" list.
--
-- A uuid[] on the conversation rather than a join table, matching how tags and
-- the details fields were added: the smallest thing that works, and a set a
-- person edits whole. Names are resolved against the org's employee roster at
-- read time, so a renamed or departed colleague needs no backfill here.
--
-- NOT NULL DEFAULT '{}' so it always reads as "nobody extra" rather than null.
-- Re-runnable.

alter table conversations
  add column if not exists collaborator_ids uuid[] not null default '{}';
