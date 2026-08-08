-- ============================================================
-- Migration 010 — Put every business on the one WhatsApp number
-- ============================================================
--
-- Migrations 007–009 built the switchboard and left it inert: routing only
-- engages when two or more active tenants advertise the same
-- `whatsapp_phone_number_id`, and only Zipicka had one. This turns it on.
--
-- This is a real behaviour change for the tenant already serving customers.
-- A message that today gets a Zipicka welcome will, if it carries no routing
-- signal ("hi"), instead get "which of these is your enquiry about?". Messages
-- that DO carry signal ("do you have this in stock?") still go straight to
-- Zipicka — classification runs first and only falls back to the menu when it
-- genuinely cannot tell.
--
-- Reversible: restore each tenant's own (or empty) phone number id and the
-- switchboard goes back to sleep, because "is this number shared?" is derived
-- from the data rather than stored as a flag that can drift out of sync.

-- ------------------------------------------------------------
-- Guard: refuse to run if the source number is not there
-- ------------------------------------------------------------
--
-- Without this, a missing or blank Zipicka number would quietly copy an empty
-- string onto all five tenants, `findOrganizationByPhoneNumberId` would match
-- on '' for any webhook, and every business would appear to share a number that
-- does not exist. That is the failure mode this codebase keeps producing: not
-- an error, just a plausible-looking wrong state. Fail loudly instead.
do $$
declare
  src_phone text;
  src_waba  text;
begin
  select whatsapp_phone_number_id, whatsapp_business_account_id
    into src_phone, src_waba
    from organizations
   where slug = 'zipicka' and is_active = true;

  if src_phone is null or src_phone = '' then
    raise exception
      'Cannot share the number: zipicka has no whatsapp_phone_number_id. Set it before running migration 010.';
  end if;

  -- ------------------------------------------------------------
  -- Point every other business at it
  -- ------------------------------------------------------------
  --
  -- atif-ali-production is included because the operator asked for every
  -- business on the number. Worth knowing what that means: its website is
  -- offline, so it has no knowledge base, and an agent routed there can only
  -- answer from its system prompt — no citable facts about services or prices.
  -- It will route and reply; it just cannot look anything up yet.
  update organizations
     set whatsapp_phone_number_id     = src_phone,
         whatsapp_business_account_id = src_waba,
         accepts_shared_number        = true,
         -- Zipicka stays the owner. Without this the migration-009 backfill,
         -- which marked each sole holder of a number as its owner, would leave
         -- five owners on one number and `findOrganizationByPhoneNumberId`
         -- would go back to being order-dependent — the exact bug 009 fixed.
         is_number_owner              = false
   where slug in ('juris-prime', 'juris-prime-legal', 'sfs-international', 'atif-ali-production')
     and is_active = true;

  update organizations
     set accepts_shared_number = true,
         is_number_owner       = true
   where slug = 'zipicka';
end
$$;

-- ------------------------------------------------------------
-- Assert the intended state actually exists
-- ------------------------------------------------------------
--
-- Not "did anything error" — this asserts the number of tenants genuinely
-- reachable on the shared number, using the same predicate the runtime query
-- uses (active, accepts_shared_number, and at least one routing keyword).
-- A tenant with no keywords can never win classification, so it would be
-- invisible to routing while looking correctly configured in the table.
do $$
declare
  reachable int;
  shared_no text;
begin
  select whatsapp_phone_number_id into shared_no
    from organizations where slug = 'zipicka';

  select count(*) into reachable
    from organizations
   where whatsapp_phone_number_id = shared_no
     and is_active = true
     and accepts_shared_number = true
     and coalesce(array_length(routing_keywords, 1), 0) > 0;

  if reachable < 5 then
    raise exception
      'Shared number reaches only % of 5 businesses — check is_active, accepts_shared_number and routing_keywords', reachable;
  end if;

  raise notice 'Switchboard live: % businesses reachable on the shared number', reachable;
end
$$;
