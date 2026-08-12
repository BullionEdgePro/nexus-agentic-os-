-- ============================================================
-- 029 — an operator's own contact number
--
-- Asked for directly. Worth recording what it does and does not do, so nobody
-- later finds it and assumes a behaviour that was never built:
--
-- It is a contact number ON RECORD. Nothing routes to it. An operator
-- administers the platform rather than working in one of its businesses, so no
-- customer is ever handed to them the way `employees.whatsapp_number` hands one
-- to a member of staff — that column is read by the direct-contact link, this
-- one is read by the profile screen and nowhere else.
--
-- Stored as digits, matching employees.whatsapp_number, so the two are
-- comparable and neither carries the brackets and spaces that break a wa.me URL.
-- ============================================================

alter table admins add column if not exists whatsapp_number text;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'admins' and column_name = 'whatsapp_number'
  ) then
    raise exception 'admins.whatsapp_number was not added';
  end if;
  raise notice 'operators have a contact number';
end $$;
