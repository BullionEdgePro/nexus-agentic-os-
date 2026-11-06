-- ============================================================
-- 109 — a username and the number behind it
--
-- WhatsApp lets people use a username instead of showing their number. Meta
-- identifies them by a business-scoped user id (BSUID, "AE.1349…"), sent on
-- every message whether or not they use a username, and sends their number
-- only when it may. Since 6 Nov 2026 Nexus keeps a customer it knows only by
-- BSUID under that BSUID (contacts.wa_id). Without this table the same person
-- became two contacts: one under their number, one under their BSUID, the
-- moment they switched a username on — or the other way round, when a customer
-- first known by username later showed their number.
--
-- So each time Meta sends a BSUID WITH a number, the pair is kept here, and a
-- message carrying only the BSUID is filed under the number it belongs to.
--
-- Global, not tenant data, like retired_whatsapp_numbers (094): a BSUID is
-- already scoped by Meta to one business portfolio, so a business can only ever
-- look up an id Meta gave it. It names no business and holds no message.
--
-- Idempotent.
-- ============================================================

create table if not exists whatsapp_user_ids (
  user_id    text primary key check (user_id ~ '^[A-Z]{2}\.(ENT\.)?[A-Za-z0-9]{1,128}$'),
  wa_id      text not null check (wa_id ~ '^[0-9]{6,20}$'),
  learnt_at  timestamptz not null default now()
);

-- Row-level security like every table created after the derived RLS pass. There
-- is no tenant column to scope on, so the policy admits every reader (094).
alter table whatsapp_user_ids enable row level security;
drop policy if exists whatsapp_user_ids_readable on whatsapp_user_ids;
create policy whatsapp_user_ids_readable on whatsapp_user_ids
  using (true) with check (true);

-- Learnt and corrected, never deleted by the app.
grant select, insert, update on whatsapp_user_ids to nexus_app;
revoke delete on whatsapp_user_ids from nexus_app;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_name = 'whatsapp_user_ids') then
    raise exception 'whatsapp_user_ids was not created';
  end if;
  raise notice 'a username id can be traced to its number';
end $$;
