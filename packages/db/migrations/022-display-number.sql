-- ============================================================
-- 022 — the number a customer can actually dial
--
-- `whatsapp_phone_number_id` is Meta's internal identifier — 1283383404852750.
-- It is what the Graph API wants and it is NOT a phone number. Nothing had ever
-- needed the human-readable one, so it was never stored, and the first thing to
-- need it (a wa.me deep link) would have built
-- `https://wa.me/1283383404852750` — a link that looks right, is published on
-- five businesses' websites, and fails in every customer's hands.
--
-- Stored per organization rather than as one platform constant, because the
-- shared number is a current arrangement and not a permanent one: the moment a
-- business gets its own number, its link must follow it without a code change.
-- ============================================================

alter table organizations add column if not exists whatsapp_display_number text;

-- Seed every business currently answering on the shared number. Matched on the
-- phone_number_id rather than by slug, so a tenant added later to the same
-- number inherits it and one moved to its own number does not.
update organizations
   set whatsapp_display_number = '971504805436'
 where whatsapp_phone_number_id = '1283383404852750'
   and whatsapp_display_number is null;

do $$
declare
  n integer;
  missing integer;
begin
  select count(*) into n from organizations where whatsapp_display_number is not null;
  select count(*) into missing
    from organizations where is_active and whatsapp_display_number is null;

  raise notice 'Display number set for % organization(s)', n;
  if missing > 0 then
    raise notice '% active organization(s) still have no dialable number — their deep links cannot be built', missing;
  end if;
end $$;
