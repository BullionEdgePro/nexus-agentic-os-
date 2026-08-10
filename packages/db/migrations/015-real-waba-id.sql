-- ============================================================
-- Migration 015 — Store the real WhatsApp Business Account id
-- ============================================================
--
-- `organizations.whatsapp_business_account_id` has always held the placeholder
-- `100000000000001` (and migration 010 copied that placeholder onto all five
-- tenants along with the shared number). Nothing reads the column at runtime,
-- which is exactly why it survived: it was wrong in a way that never errored.
--
-- It cost real time on 2026-08-10. Diagnosing what looked like an inbound
-- outage needed `GET /{waba-id}/subscribed_apps`, and the platform could not
-- supply the id. The system-user token lacks `business_management`, so the
-- WABA could not be enumerated from the business either. The real value was
-- eventually recovered from BullMQ job keys in Redis — Meta puts the WABA id in
-- `entry[].id`, and the queue had been keying jobs on it:
--
--   bull:whatsapp-inbound-webhook:1555307469433965-wamid.HBgMOTcxNTQzMzk5MDA1...
--
-- Confirmed against Graph: id 1555307469433965, name "Zipicka", and the
-- subscribed app is "Nexus Agentic OS" (2102184453754377).
--
-- All five tenants share one number, therefore one WABA. When a tenant is
-- eventually moved to its own number it gets its own WABA id here too.
--
-- Idempotent.

update organizations
   set whatsapp_business_account_id = '1555307469433965'
 where whatsapp_phone_number_id = (
         select whatsapp_phone_number_id from organizations where slug = 'zipicka'
       )
   and whatsapp_business_account_id <> '1555307469433965';

-- ------------------------------------------------------------
-- Assert it landed, and that no placeholder survives
-- ------------------------------------------------------------
--
-- Checks for the *shape* of a placeholder rather than the one literal value,
-- so a different invented id does not slip through the same gap.
do $$
declare
  fake int;
  real_count int;
begin
  select count(*) into fake
    from organizations
   where is_active
     and (whatsapp_business_account_id is null
          or whatsapp_business_account_id = ''
          or whatsapp_business_account_id ~ '^10{10,}[0-9]?$');

  if fake > 0 then
    raise exception '% active tenant(s) still carry a placeholder WABA id', fake;
  end if;

  select count(*) into real_count
    from organizations
   where is_active and whatsapp_business_account_id = '1555307469433965';

  raise notice 'Real WABA id stored for % active tenant(s)', real_count;
end
$$;
