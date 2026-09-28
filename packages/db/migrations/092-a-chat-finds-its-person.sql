-- ============================================================
-- A chat finds its person — round-robin auto-assign
-- ============================================================
--
-- DoubleTick assigns new chats round-robin to whoever is working. Nexus had
-- assignment only by hand, so on a busy day every chat sat in Unassigned until
-- somebody noticed it.
--
-- 1. organizations.auto_assign — per business, OFF by default. Turning it on is
--    the owner's decision: an assigned chat is answered by that person's AI twin
--    under their name, which is a change in how the business sounds.
--
-- 2. employees.last_auto_assigned_at — the "round" in round-robin. Among the
--    people eligible right now, the one with the fewest open chats goes first,
--    and a tie goes to whoever was handed one longest ago. Kept on the employee
--    row rather than derived from conversation_events because on the shared
--    number those events belong to the number's owner, and the serving
--    business's pick runs where it cannot see them.
--
-- WHO IS ELIGIBLE is decided in code (apps/api/src/services/availability.ts),
-- not here: active, on shift now by their rota, not in a calendar meeting, and
-- with their AI twin ON — so when they step away the twin keeps answering in
-- their name. An auto-assignment to someone whose twin is off would silence the
-- AI on that chat the moment they left.

alter table organizations add column if not exists auto_assign boolean not null default false;
alter table employees add column if not exists last_auto_assigned_at timestamptz;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'organizations' and column_name = 'auto_assign'
  ) then
    raise exception 'organizations.auto_assign was not added';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'employees' and column_name = 'last_auto_assigned_at'
  ) then
    raise exception 'employees.last_auto_assigned_at was not added';
  end if;
  raise notice 'auto-assign ready: off for every business until its owner turns it on';
end $$;
