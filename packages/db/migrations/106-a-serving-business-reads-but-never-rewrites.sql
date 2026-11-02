-- A business serving routed chats reads their rows, and never rewrites them.
--
-- Migrations 054, 056 and 058 let the business a chat is routed to read that
-- chat's rows by widening the USING clause of one policy per table:
--
--   conversations          owner, or routed_organization_id        (054)
--   conversation_metrics   owner, or serving_organization_id       (054)
--   messages               owner, or serving_organization_id       (058)
--   contacts               owner, or served_organization_ids       (056)
--
-- Each is a policy FOR ALL, and in Postgres a policy's USING also decides which
-- rows UPDATE and DELETE can reach. So under its own tenant the serving business
-- could delete the number owner's conversations, metrics and the contacts it
-- serves -- a contact's delete cascades into every business's rows for that
-- person -- or set organization_id to itself and take a row over: the new row
-- passes the owner-only WITH CHECK because it now names the serving business.
-- On messages, whose WITH CHECK 058 opened to the serving business so a firm
-- may answer its own customer, it could also edit any message in the chats it
-- serves. (It could not delete one: migration 048 removed the DELETE grant.)
--
-- Nothing does any of this today. Every UPDATE of these tables runs in the
-- number owner's pipeline, across all tenants, or in a script; no business-
-- scoped route and no withServingTenant body writes them (audited 2026-11-02,
-- spec docs/superpowers/specs/2026-11-02-serving-read-only-design.md §3). It is
-- a door, not a burglary -- found by the review of migration 105, which closed
-- the same door on lead_assessments.
--
-- ============================================================
-- RESTRICTIVE POLICIES, ADDED -- THE OLD ONES UNTOUCHED
-- ============================================================
--
-- Each table gains two owner-only RESTRICTIVE policies, for UPDATE and for
-- DELETE. Restrictive policies AND with the permissive ones, so changing and
-- deleting become the owner's (or a cross-tenant context's) alone, while SELECT
-- and INSERT keep exactly what 054, 056 and 058 granted -- including 058's
-- reply insert. Rewriting the four policies instead would restate three
-- migrations' carefully argued grants to get the same result.
--
-- ONE TRANSACTION, AND IT GIVES UP RATHER THAN WAITS, as 105: these tables are
-- written by every message, from reply transactions open through an AI call.
-- If the lock timeout trips, nothing changed; run it again at a quieter moment.
-- Safe to run twice.

begin;
set local lock_timeout = '5s';

-- ------------------------------------------------------------
-- conversations
-- ------------------------------------------------------------

drop policy if exists conversations_owner_updates on conversations;
create policy conversations_owner_updates on conversations
  as restrictive
  for update
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

drop policy if exists conversations_owner_deletes on conversations;
create policy conversations_owner_deletes on conversations
  as restrictive
  for delete
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- conversation_metrics
-- ------------------------------------------------------------

drop policy if exists conversation_metrics_owner_updates on conversation_metrics;
create policy conversation_metrics_owner_updates on conversation_metrics
  as restrictive
  for update
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

drop policy if exists conversation_metrics_owner_deletes on conversation_metrics;
create policy conversation_metrics_owner_deletes on conversation_metrics
  as restrictive
  for delete
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- messages -- delivery receipts and unsends arrive as the owner
-- ------------------------------------------------------------

drop policy if exists messages_owner_updates on messages;
create policy messages_owner_updates on messages
  as restrictive
  for update
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- A second lock: 048 already removed the DELETE grant. Should it ever come
-- back, a serving business still cannot delete the owner's record.
drop policy if exists messages_owner_deletes on messages;
create policy messages_owner_deletes on messages
  as restrictive
  for delete
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- contacts
-- ------------------------------------------------------------

drop policy if exists contacts_owner_updates on contacts;
create policy contacts_owner_updates on contacts
  as restrictive
  for update
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

drop policy if exists contacts_owner_deletes on contacts;
create policy contacts_owner_deletes on contacts
  as restrictive
  for delete
  using (
    organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

-- ------------------------------------------------------------
-- Assert
-- ------------------------------------------------------------

do $$
declare
  t text;
  ok boolean;
begin
  foreach t in array array['conversations', 'conversation_metrics', 'messages', 'contacts']
  loop
    select count(*) = 2 into ok
      from pg_policies
     where schemaname = 'public' and tablename = t
       and permissive = 'RESTRICTIVE'
       and ((policyname = t || '_owner_updates' and cmd = 'UPDATE')
         or (policyname = t || '_owner_deletes' and cmd = 'DELETE'))
       and qual not like '%routed_organization_id%'
       and qual not like '%serving_organization_id%'
       and qual not like '%served_organization_ids%';
    if not ok then
      raise exception '% must have owner-only restrictive policies for UPDATE and DELETE', t;
    end if;

    select exists (
      select 1 from pg_policies
       where schemaname = 'public' and tablename = t and policyname = t || '_tenant_isolation'
    ) into ok;
    if not ok then
      raise exception '%_tenant_isolation is missing: 106 adds to it, it does not replace it', t;
    end if;
  end loop;

  -- 058's grant survives: a firm may still answer its own customer.
  select exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'messages'
       and policyname = 'messages_tenant_isolation'
       and with_check like '%serving_organization_id%'
  ) into ok;
  if not ok then
    raise exception 'messages_tenant_isolation no longer lets the serving business insert its reply (058)';
  end if;
end $$;

commit;
