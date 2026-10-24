-- ============================================================
-- Snooze
-- ============================================================
--
-- 24 Oct 2026, the Focus workspace. A staff member puts a chat aside until a
-- time; it leaves every waiting count until then, or until the customer
-- writes again — whichever comes first. No job wakes it: the rule is read
-- where it is used (NOT_SNOOZED_SQL in packages/db/src/conversations.ts).
-- Spec: docs/superpowers/specs/2026-10-24-focus-workspace-design.md
-- Applied as the owner role before the code that reads it is deployed.

alter table conversations add column if not exists snoozed_until timestamptz;
alter table conversations add column if not exists snoozed_at timestamptz;
alter table conversations add column if not exists snoozed_by text;

create index if not exists idx_conversations_snoozed
  on conversations (snoozed_until) where snoozed_until is not null;

-- The queue's reason tag reads each chat's latest lead assessment.
create index if not exists idx_lead_assessments_conversation
  on lead_assessments (conversation_id, created_at desc) where conversation_id is not null;
