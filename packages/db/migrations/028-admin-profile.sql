-- ============================================================
-- 028 — an operator has a profile too
--
-- The account panel told operators "Operator accounts have no profile to edit."
-- That was true of the code and false of the data: `admins` has carried
-- full_name since accounts existed, and /api/me simply returned null for it —
-- which is also why the panel showed the same email twice, as name and as
-- address.
--
-- This adds the one column that was genuinely missing. WhatsApp number is
-- deliberately NOT added: an operator administers the platform rather than
-- working in one of its businesses, so no customer is ever handed to them
-- directly and the field would be a box that does nothing.
-- ============================================================

alter table admins add column if not exists avatar_url text;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'admins' and column_name = 'avatar_url'
  ) then
    raise exception 'admins.avatar_url was not added';
  end if;
  raise notice 'operators can have a face';
end $$;
