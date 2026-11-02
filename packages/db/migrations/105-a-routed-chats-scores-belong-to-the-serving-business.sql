-- A routed chat's lead scores belong to the business serving it.
--
-- Found 2026-11-02 by the SFS workflow audit's review: lead scoring runs on
-- every inbound message inside the number owner's transaction, so every score
-- is filed under Zipicka -- including the chats the switchboard sent to SFS,
-- ABR or Juris Prime. `lead_assessments` kept migration 018's owner-only
-- policy, so under the serving business's tenant those scores do not exist:
-- no reason tag in its inbox, no lead history on its customer, no way to label
-- the lead, and a routed sales pitch counted as a new lead. Zipicka, meanwhile,
-- counted scores for chats it does not serve.
--
-- ============================================================
-- THE SAME SHAPE AS 054, FOR THE SAME REASONS
-- ============================================================
--
-- The rows are not wrong: the reply pipeline writes them as the owner, and
-- writing the serving business's id would fail the policy's `with check`.
-- What was missing is the column saying who serves the chat, kept true by
-- trigger rather than by every writer, and a read policy that uses it.
--
-- Writing the score under the serving business instead (withServingTenant, as
-- bookings do) was the alternative and is worse here: the triage menu routes a
-- chat AFTER its first message has been scored, and the same write refreshes
-- the owner's `contacts` row, which must stay the owner's.
--
-- A DELETED CHAT KEEPS ITS SCORES WHERE THEY WERE. `conversation_id` is
-- `on delete set null`, which fires the update trigger; recomputing then would
-- hand a routed chat's scores back to the number's owner. The row keeps the
-- serving business it had, and the backfill below leaves such rows alone.
--
-- READ, NOT WRITE, AND THAT HAS TO BE A SEPARATE POLICY. A policy for all
-- commands whose USING is widened widens which rows UPDATE and DELETE can
-- reach too: the serving business could delete the owner's scores or take
-- them over. So the owner-only policy stays exactly as it was, and the serving
-- business gets a second, SELECT-only policy (final review, 2 Nov 2026).
--
-- ONE TRANSACTION, AND IT GIVES UP RATHER THAN WAITS. Applied by hand with
-- psql, which otherwise commits each statement on its own: this table is
-- written by every inbound message, from a reply transaction that stays open
-- through the AI call, so a lock here can queue the inbox behind a slow reply.
-- With a lock timeout the whole file either lands at once or not at all; if it
-- times out, run it again at a quieter moment.
--
-- Safe to run twice. Runs after 052 (which resets every policy to the
-- owner-only shape) and 054 (whose routing cascade this extends).

begin;
set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- 1. The column
-- ------------------------------------------------------------

alter table lead_assessments
  add column if not exists serving_organization_id uuid references organizations(id);

-- ------------------------------------------------------------
-- 2. Kept true by trigger
-- ------------------------------------------------------------

create or replace function set_serving_organization_for_assessment()
returns trigger as $fn$
declare
  serving uuid;
begin
  if new.conversation_id is null then
    -- No chat (a staff capture serves its own business), or the chat was
    -- deleted (the row keeps the business that served it).
    if tg_op = 'UPDATE' then
      new.serving_organization_id := coalesce(old.serving_organization_id, new.organization_id);
    else
      new.serving_organization_id := new.organization_id;
    end if;
    return new;
  end if;

  select coalesce(c.routed_organization_id, c.organization_id)
    into serving
    from conversations c
   where c.id = new.conversation_id;
  new.serving_organization_id := coalesce(serving, new.organization_id);
  return new;
end;
$fn$ language plpgsql;

drop trigger if exists trg_lead_assessments_serving on lead_assessments;
create trigger trg_lead_assessments_serving
  before insert or update of conversation_id on lead_assessments
  for each row execute function set_serving_organization_for_assessment();

-- 054's cascade, with the scores added: when the triage menu routes a chat
-- after "hi" was scored, that score follows the chat like its messages do.
-- The two statements from 054 are unchanged.
create or replace function cascade_serving_organization()
returns trigger as $fn$
begin
  update messages
     set serving_organization_id = coalesce(new.routed_organization_id, new.organization_id)
   where conversation_id = new.id;
  update conversation_metrics
     set serving_organization_id = coalesce(new.routed_organization_id, new.organization_id)
   where conversation_id = new.id;
  update lead_assessments
     set serving_organization_id = coalesce(new.routed_organization_id, new.organization_id)
   where conversation_id = new.id;
  return null;
end;
$fn$ language plpgsql;

-- ------------------------------------------------------------
-- 3. Backfill -- a recomputation where a conversation can answer
-- ------------------------------------------------------------

update lead_assessments la
   set serving_organization_id = coalesce(c.routed_organization_id, c.organization_id)
  from conversations c
 where c.id = la.conversation_id
   and la.serving_organization_id is distinct from coalesce(c.routed_organization_id, c.organization_id);

-- No conversation: a capture, or a chat deleted before this column existed
-- (nothing left to say who served it, so it stays with its owner).
update lead_assessments
   set serving_organization_id = organization_id
 where serving_organization_id is null;

alter table lead_assessments alter column serving_organization_id set not null;

-- A label belongs to the lead's business. Until now only the number's owner
-- could label a routed lead; such a label moves to the business serving it,
-- or that business's own label would collide (on assessment_id) with a row its
-- tenant cannot see.
update lead_labels l
   set organization_id = a.serving_organization_id
  from lead_assessments a
 where a.id = l.assessment_id
   and l.organization_id = a.organization_id
   and a.serving_organization_id <> a.organization_id;

create index if not exists idx_lead_assessments_serving
  on lead_assessments(serving_organization_id, created_at desc);

-- ------------------------------------------------------------
-- 4. The policies: owner-only for everything, plus reading for the server
-- ------------------------------------------------------------

alter table lead_assessments enable row level security;

-- Unchanged from 052's standard shape: inserting, changing and deleting a score
-- stay with the number's owner, whose transaction the pipeline scores in.
drop policy if exists lead_assessments_tenant_isolation on lead_assessments;
create policy lead_assessments_tenant_isolation on lead_assessments
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- The business serving the chat may READ its scores. Permissive policies add
-- up for SELECT only, so this reaches no row for UPDATE or DELETE.
drop policy if exists lead_assessments_serving_read on lead_assessments;
create policy lead_assessments_serving_read on lead_assessments
  for select
  using (serving_organization_id::text = current_setting('app.current_org', true));

-- ------------------------------------------------------------
-- 5. Assert
-- ------------------------------------------------------------

do $$
declare
  unfilled int;
  policy_ok boolean;
begin
  select count(*) into unfilled from lead_assessments where serving_organization_id is null;
  if unfilled > 0 then
    raise exception '% lead assessment(s) have no serving business after the backfill', unfilled;
  end if;

  select exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'lead_assessments'
       and policyname = 'lead_assessments_tenant_isolation'
       and qual not like '%serving_organization_id%'
       and with_check not like '%serving_organization_id%'
  ) and exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'lead_assessments'
       and policyname = 'lead_assessments_serving_read'
       and cmd = 'SELECT'
       and qual like '%serving_organization_id%'
  ) into policy_ok;
  if not policy_ok then
    raise exception 'lead_assessments must be owner-only for every command, plus a SELECT-only policy for the serving business';
  end if;
end $$;

commit;
