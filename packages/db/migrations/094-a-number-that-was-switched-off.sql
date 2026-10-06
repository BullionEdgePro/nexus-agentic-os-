-- ============================================================
-- A WhatsApp number that was switched off
-- ============================================================
--
-- On 2026-10-06 the owner deregistered the shared company number from the
-- WhatsApp Cloud API: from now on each staff member answers on their OWN
-- WhatsApp Business number, and a customer who writes to a person's number is
-- that person's chat.
--
-- organizations.whatsapp_phone_number_id is NOT NULL and every business still
-- points at the old line, so without a record of the switch-off every send
-- path would keep reaching for it — a reply, a campaign, a staff alert — and
-- fail at Meta with an error nobody in the inbox can act on. This table is that
-- record. It is about a NUMBER, not a business, because that is what Meta
-- switched off: the moment the same line is registered and given to someone
-- again (assignEmployeeWhatsAppNumber), its row is removed and it sends again.
--
-- Read by findConversationById (a chat on a retired line has no number to
-- reply from), the assignment alert, business and staff campaigns, and the
-- Channels screen. Global, not tenant data: it holds no customer and no
-- business, only Meta's id for a line, so there is nothing to row-level-scope.

create table if not exists retired_whatsapp_numbers (
  phone_number_id text primary key,
  display_number  text,
  retired_at      timestamptz not null default now(),
  reason          text not null check (char_length(reason) between 1 and 300)
);

-- Row-level security like every table created after the derived RLS pass (the
-- invariant a-finding-names-the-business-it-is-about pins). There is no tenant
-- column to scope on, so the policy admits every reader: the switch-off of a
-- line is the same fact for every business and every staff member.
alter table retired_whatsapp_numbers enable row level security;
drop policy if exists retired_whatsapp_numbers_readable on retired_whatsapp_numbers;
create policy retired_whatsapp_numbers_readable on retired_whatsapp_numbers
  using (true) with check (true);

grant select, insert, delete on retired_whatsapp_numbers to nexus_app;
