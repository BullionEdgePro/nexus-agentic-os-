-- The inbox was still empty, and the conversation was not what was missing.
--
-- Migration 054 let a serving business read the conversation it is answering.
-- Measured immediately afterwards, as ABR:
--
--   conversations abr can see                 1
--   contacts abr can see                      0
--   conversations surviving the contact join  0
--
-- `getConversationsForOrganization` joins contacts to get the customer's name,
-- and a contact belongs to the number's owner because it is created when the
-- message arrives -- before anybody knows which business is being asked for. So
-- the inner join silently removed the row that 054 had just made visible, and
-- ABR's inbox read zero for a customer who was waiting in it.
--
-- A LEFT JOIN WOULD HAVE HIDDEN THIS RATHER THAN FIXED IT: the conversation
-- would appear with no name and no number, which is not an inbox entry anybody
-- can act on.
--
-- ============================================================
-- WHY AN ARRAY AND NOT ANOTHER serving_organization_id
-- ============================================================
--
-- A conversation has one serving business. A CONTACT CAN HAVE SEVERAL: the same
-- person may ask the letting agent about a flat in March and the law firm about
-- a lease in April, on the same number, and both firms need their name. A single
-- column would have to pick one and be wrong for the other.
--
-- The alternative was a subquery in the policy -- "exists a conversation for
-- this contact routed to me". Rejected for the reason stated in 054: a policy
-- whose truth depends on another table's policy is not something anybody can
-- reason about under pressure. An array of ids is a plain column test.

alter table contacts
  add column if not exists served_organization_ids uuid[] not null default '{}';

-- ------------------------------------------------------------
-- Kept true by trigger, from the conversations themselves
-- ------------------------------------------------------------

create or replace function refresh_contact_served_organizations()
returns trigger as $fn$
declare
  target uuid;
begin
  target := coalesce(new.contact_id, old.contact_id);
  if target is null then
    return null;
  end if;

  update contacts ct
     set served_organization_ids = coalesce((
           select array_agg(distinct coalesce(c.routed_organization_id, c.organization_id))
             from conversations c
            where c.contact_id = target
         ), '{}')
   where ct.id = target;

  return null;
end;
$fn$ language plpgsql;

-- Insert covers the first conversation; the routing update covers the triage
-- menu, which is where a business is chosen and is always AFTER the contact
-- already exists. Delete keeps the array from naming a business that no longer
-- has any conversation with this person.
drop trigger if exists trg_conversations_contact_serving on conversations;
create trigger trg_conversations_contact_serving
  after insert or delete or update of routed_organization_id, contact_id on conversations
  for each row execute function refresh_contact_served_organizations();

-- ------------------------------------------------------------
-- Backfill
-- ------------------------------------------------------------

update contacts ct
   set served_organization_ids = coalesce((
         select array_agg(distinct coalesce(c.routed_organization_id, c.organization_id))
           from conversations c
          where c.contact_id = ct.id
       ), '{}');

create index if not exists idx_contacts_served
  on contacts using gin (served_organization_ids);

-- ------------------------------------------------------------
-- The policy
-- ------------------------------------------------------------

alter table contacts enable row level security;
drop policy if exists contacts_tenant_isolation on contacts;
create policy contacts_tenant_isolation on contacts
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.current_org', true)::uuid = any (served_organization_ids)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  -- Writes stay with the owner, as in 054. A serving business reads the person
  -- it is talking to; creating and editing the contact record is the reply
  -- path's job, and the reply path runs as the owner.
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- Assert
-- ------------------------------------------------------------

do $$
declare
  orphaned int;
  policy_ok boolean;
begin
  -- Every contact with a conversation must name at least one business, or the
  -- backfill did not run and somebody's inbox is still empty.
  select count(*) into orphaned
    from contacts ct
   where exists (select 1 from conversations c where c.contact_id = ct.id)
     and cardinality(ct.served_organization_ids) = 0;
  if orphaned > 0 then
    raise exception '% contact(s) have conversations and no serving business', orphaned;
  end if;

  select exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'contacts'
       and policyname = 'contacts_tenant_isolation'
       and qual like '%served_organization_ids%'
  ) into policy_ok;
  if not policy_ok then
    raise exception 'the contacts policy does not read served_organization_ids';
  end if;

  raise notice 'A contact is now readable by every business that is serving them.';
end $$;
