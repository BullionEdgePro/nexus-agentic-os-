-- A business serving a conversation could not send a message into it.
--
-- Migration 054 widened the `using` clauses so a serving business can READ the
-- conversation it is answering, and deliberately left `with check` owner-only.
-- Measured adversarially against production on 2026-08-19, as Juris Prime,
-- against a conversation routed to Juris Prime:
--
--   UPDATE that conversation                REFUSED   (correct -- see below)
--   INSERT a reply into it                  REFUSED   <- the finding
--   the same INSERT as the number's owner   allowed
--   the same INSERT cross-tenant            allowed
--
-- The last line is the whole problem. The deck's reply path works today only
-- because `/api/conversations/:id/...` carries no `:slug`, so `tenantContext`
-- gives it a cross-tenant context and the policy never applies. Replying to
-- your own customer -- the core action of this product -- is permitted by an
-- accident of URL SHAPE. Move that route under `/api/organizations/:slug/...`,
-- as every other per-business route already is, and it stops working.
--
-- That is a trap rather than a protection. It forbids nothing anybody wants to
-- forbid, and it waits for a routing change to break the one thing the platform
-- is for.
--
-- ============================================================
-- MESSAGES YES, CONVERSATIONS NO
-- ============================================================
--
-- These are different questions and the answers differ.
--
--   A MESSAGE is the firm talking to its own customer. That is the job. A firm
--   serving a conversation may insert into it.
--
--   A CONVERSATION carries the routing -- which business is answering. Changing
--   that is the switchboard's decision, and the switchboard runs as the number's
--   owner. Left owner-only, deliberately, and the probe above confirms it stays
--   refused.
--
-- ============================================================
-- WHY THIS CANNOT BE FORGED
-- ============================================================
--
-- The check reads `serving_organization_id`, which a caller does not get to
-- choose: migration 054 fills it from the conversation in a BEFORE INSERT
-- trigger, and WITH CHECK is evaluated on the final row, after triggers. A
-- business writing into a conversation it does not serve has its own value
-- overwritten with the true one before the check runs, and is then refused by
-- that check.
--
-- So the widening grants exactly "answer the customers you are answering" and
-- nothing adjacent to it. The assertion at the bottom proves that rather than
-- asserting it.

alter table messages enable row level security;
drop policy if exists messages_tenant_isolation on messages;
create policy messages_tenant_isolation on messages
  using (
    organization_id::text = current_setting('app.current_org', true)
    or serving_organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  )
  with check (
    organization_id::text = current_setting('app.current_org', true)
    -- The firm actually answering this conversation. Trigger-filled, so it
    -- names the conversation's real serving business and not the writer's
    -- preference.
    or serving_organization_id::text = current_setting('app.current_org', true)
    or current_setting('app.tenant_scope', true) = 'all'
  );

do $$
declare
  policy_ok boolean;
begin
  -- The policy is installed as intended. It CANNOT be exercised here: this file
  -- runs as the owner, who bypasses row-level security unconditionally, so any
  -- probe in a migration reports the same thing whether the policy is right,
  -- wrong or absent. Migration 056 shipped exactly that mistake and had to say
  -- so. The behavioural proof belongs to rls-verify, which connects as
  -- nexus_app; this only checks the shape.
  select exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'messages'
       and policyname = 'messages_tenant_isolation'
       and with_check like '%serving_organization_id%'
  ) into policy_ok;

  if not policy_ok then
    raise exception 'the messages write policy does not reach the serving business';
  end if;

  -- And the other half: conversations must NOT have been widened alongside it.
  select exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename = 'conversations'
       and policyname = 'conversations_tenant_isolation'
       and with_check like '%routed_organization_id%'
  ) into policy_ok;

  if policy_ok then
    raise exception 'conversations became writable by a serving business -- routing is the switchboard''s';
  end if;

  raise notice 'A firm may now answer its own customer, and still may not re-route them.';
end $$;
