-- ============================================================
-- An email thread belongs to the mailbox it came from
-- ============================================================
--
-- Email conversations were created unassigned. The mail in them was read from a
-- staff member's own mailbox, for a client in that person's own book — but it
-- landed in "Unassigned", and staff open the inbox on "My chats", so their own
-- clients' email was on screen for nobody.
--
-- From now on the sync assigns a NEW email conversation to the mailbox's owner
-- (packages/db/src/email-sync.ts). This is the one-time catch-up for the ones
-- created before that: an unassigned email thread goes to the staff member who
-- owns the contact — the same person whose mailbox the sync read it from
-- (clientContactsWithEmail scopes on contacts.owner_employee_id).
--
-- ONLY unassigned threads, ONLY active owners in the same business. A thread
-- somebody has already been given is left alone, and nobody is handed work
-- under a business they do not belong to. Each assignment is written on the
-- thread's timeline, so the change explains itself.
--
-- Idempotent: a second run finds nothing unassigned to take.

with taken as (
  update conversations c
     set employee_id = ct.owner_employee_id
    from contacts ct
    join employees e on e.id = ct.owner_employee_id
   where c.contact_id = ct.id
     and c.channel = 'email'
     and c.employee_id is null
     and ct.owner_employee_id is not null
     and e.is_active
     and e.organization_id = coalesce(c.routed_organization_id, c.organization_id)
  returning c.id, c.organization_id, e.full_name
)
insert into conversation_events
  (organization_id, conversation_id, kind, actor, actor_name, subject_name)
select organization_id, id, 'assigned', 'email-sync', 'Email sync', full_name
  from taken;

-- ------------------------------------------------------------
-- Check
-- ------------------------------------------------------------
do $$
declare
  left_over integer;
begin
  select count(*) into left_over
    from conversations c
    join contacts ct on ct.id = c.contact_id
    join employees e on e.id = ct.owner_employee_id
   where c.channel = 'email'
     and c.employee_id is null
     and e.is_active
     and e.organization_id = coalesce(c.routed_organization_id, c.organization_id);
  if left_over > 0 then
    raise exception '% email threads with an active owner are still unassigned', left_over;
  end if;
  raise notice 'email threads now belong to their mailbox owner';
end $$;
