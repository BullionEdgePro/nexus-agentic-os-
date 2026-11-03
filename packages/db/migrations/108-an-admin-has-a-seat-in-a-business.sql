-- ============================================================
-- 108 — an admin has a seat in a business
--
-- Asked for directly (3 Nov 2026): "admin also can connect everything like
-- staff". Every connection on this platform — the WhatsApp Business number,
-- Gmail, the business mailbox, TikTok — is filed under one person in one
-- business, (organization_id, employee_id): that is what routes a message on a
-- person's number to them, fills their mail, and lists their number in Bulk.
-- An admin administers every business and belonged to none, so they could
-- connect nothing.
--
-- So an admin gets a SEAT: an ordinary staff record in the business they
-- connect for, linked back to their admin account here. Every staff flow then
-- works for them unchanged. One seat per admin per business; a staff record
-- that was already that person's (same email) becomes the seat rather than a
-- second one. A seat has no access code, so nobody signs in to it as staff.
--
-- ON DELETE SET NULL: removing an admin account leaves the record (and the
-- chats and connections filed under it) as a plain staff record.
--
-- Idempotent.
-- ============================================================

alter table employees add column if not exists admin_id uuid references admins(id) on delete set null;

create unique index if not exists employees_one_seat_per_admin
  on employees (organization_id, admin_id)
  where admin_id is not null;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'employees' and column_name = 'admin_id'
  ) then
    raise exception 'employees.admin_id was not added';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'employees_one_seat_per_admin') then
    raise exception 'employees_one_seat_per_admin was not created';
  end if;
  raise notice 'an admin can have a seat in a business';
end $$;
