-- Six writers, one boolean, and no record of which one fired.
--
-- `conversations.is_human_handoff` says THAT a conversation is held by a
-- person. It has never said by whom, when, or why -- and the moment it flips
-- back, the fact it was ever held is gone.
--
-- WHAT THAT ABSENCE COST, on 2026-08-20. A customer had been waiting 28 hours.
-- The flag read false, so customer-waiting said "the AI was not paused, so it
-- should have answered -- check the reply pipeline", and an afternoon went into
-- chasing a reply pipeline that was working perfectly. The truth: a colleague
-- had answered on the 10th, the customer wrote again on the 19th while the flag
-- was still set, the agent correctly stayed silent, and the flag was cleared
-- afterwards by something nothing recorded. Reconstructing that took message
-- timestamps, the git log, and a guess. This table makes it one query.
--
-- The six writers each mean something different and none of them said so:
--
--   processor      the agent escalated and paused itself
--   processor      the stale-handoff release handed it back automatically
--   conversations  a colleague replied from the inbox
--   conversations  somebody toggled it by hand
--   employees      an employee took the conversation
--
-- THE REASON IS A REQUIRED ARGUMENT, not an optional one, and the recording
-- happens inside setConversationHandoff rather than at the call sites. Those two
-- decisions are the whole design: a seventh writer cannot be added without
-- stating why, and cannot forget to leave a trace. An audit trail that depends
-- on every caller remembering is a convention, and this codebase has spent nine
-- separate defects learning that a convention is a property nobody can check.
create table if not exists conversation_custody (
  id              uuid primary key default gen_random_uuid(),
  -- Denormalised so RLS has a column to filter on without joining conversations.
  organization_id uuid not null references organizations(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,

  -- true  = a person now holds this conversation and the agent will not answer
  -- false = it has been handed back to the agent
  held            boolean not null,

  -- Why it changed hands. Constrained rather than free text: this is read by
  -- code that has to branch on it, and a typo would silently become a new
  -- category nothing handles.
  reason          text not null check (reason in (
                    'agent_escalated',
                    'human_replied',
                    'taken_by_employee',
                    'manual_toggle',
                    'stale_release'
                  )),

  -- Who did it. A session subject, an employee id, or null for the platform
  -- acting on its own (the stale release). Deliberately text rather than a
  -- foreign key: admins, employees and the system are three different
  -- identifier spaces, and a nullable FK to one of them would misrepresent the
  -- other two.
  actor           text,

  created_at      timestamptz not null default now()
);

-- The question this table exists to answer is always "what happened to THIS
-- conversation", newest first.
create index if not exists idx_conversation_custody_conversation
  on conversation_custody (conversation_id, created_at desc);

-- And the operator question: who is holding things right now, per business.
create index if not exists idx_conversation_custody_org
  on conversation_custody (organization_id, created_at desc);

alter table conversation_custody enable row level security;

-- SCOPED TO THE OWNING ORGANIZATION, matching conversations itself.
--
-- A routed conversation belongs to the shared number's owner, so its custody
-- rows are the owner's too. Filing them under the serving business would split
-- one conversation's history across two tenants, and neither half would read
-- correctly on its own. Readers that need the serving business's view go
-- through withServingTenant, exactly as every other read on this path does.
drop policy if exists conversation_custody_tenant_isolation on conversation_custody;
create policy conversation_custody_tenant_isolation on conversation_custody
  using (organization_id::text = current_setting('app.current_org', true)
         or current_setting('app.tenant_scope', true) = 'all')
  with check (organization_id::text = current_setting('app.current_org', true)
              or current_setting('app.tenant_scope', true) = 'all');

comment on table conversation_custody is
  'Every change of hands between the agent and a person. Written only by setConversationHandoff, which requires a reason -- so no caller can change custody silently.';

-- NO BACKFILL, DELIBERATELY.
--
-- Every conversation that changed hands before this migration did so without
-- leaving a record, and there is nothing to reconstruct one from -- which is
-- the entire problem being fixed. Inventing rows from message senders would
-- produce a history that looks authoritative and is guessed, and a guessed
-- audit trail is worse than an absent one: the absence is at least honest.
-- Conversations older than this migration simply have no custody history, and
-- readers must treat an empty history as "not recorded", never as "never held".
