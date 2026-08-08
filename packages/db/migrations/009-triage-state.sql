-- ============================================================
-- Migration 009 — Triage state for the switchboard
-- ============================================================
--
-- Migration 007 added WHERE a conversation is routed. This adds WHETHER we have
-- already asked, which is the piece that makes the routing loop safe to run.
--
-- Without it, `resolveTriageReply` would have to be attempted on every inbound
-- message, and a first message of "3" from someone who has never seen a menu
-- would silently select the third business — including its governance policy.
-- Recording that a menu was actually sent means a bare ordinal is only ever
-- read as an answer to a question we really asked.
--
-- `triage_attempts` bounds the loop. A customer whose messages never classify
-- must not be handed the same menu forever; after a few tries a human takes
-- over. Storing the count rather than inferring it keeps the reason a
-- conversation escalated visible in the data.
--
-- Additive and idempotent. Every column defaults to the behaviour that existed
-- before this migration, so it is a no-op until a number is genuinely shared.

alter table conversations
  add column if not exists triage_prompted_at timestamptz;

alter table conversations
  add column if not exists triage_attempts int not null default 0;

-- ============================================================
-- A deterministic owner for a shared number
-- ============================================================
--
-- A shared number means several rows in `organizations` carry the same
-- `whatsapp_phone_number_id`. `findOrganizationByPhoneNumberId` returned
-- rows[0] of an unordered query, so with a shared number the "owning" tenant —
-- the one that owns the contact records and the conversation — could differ
-- between two calls in the same request. Postgres is entitled to return those
-- rows in any order; nothing would have errored, the owner would just have
-- drifted.
--
-- The flag makes the owner an explicit fact rather than an artifact of scan
-- order, and the query orders by it.
alter table organizations
  add column if not exists is_number_owner boolean not null default false;

-- Zipicka holds the only live WhatsApp number today, so it owns it. Written as
-- a plain update rather than a guessed rule: if the number is later moved, this
-- flag is the single place that says who owns it.
update organizations set is_number_owner = true where slug = 'zipicka';

-- Any tenant that is the sole holder of its own number obviously owns it.
-- Backfilled so the ordering has a true value to sort on rather than relying on
-- the created_at tiebreak.
update organizations o set is_number_owner = true
where o.is_number_owner = false
  and o.whatsapp_phone_number_id is not null
  and o.whatsapp_phone_number_id <> ''
  and not exists (
    select 1 from organizations p
    where p.whatsapp_phone_number_id = o.whatsapp_phone_number_id
      and p.id <> o.id
  );

-- ============================================================
-- Turning the switchboard on
-- ============================================================
--
-- NOT done here, deliberately. The mechanism ships inert: routing only engages
-- when two or more active tenants advertise the SAME phone number, and today
-- only Zipicka has one. Pointing the other four at it is a visible behaviour
-- change for the one tenant currently serving customers — a greeting that today
-- gets a Zipicka welcome would instead get "which of these is your enquiry
-- about?" — so it is left as a deliberate switch rather than a side effect of
-- deploying code.
--
-- To share Zipicka's number with every business:
--
--   update organizations
--      set whatsapp_phone_number_id = (
--            select whatsapp_phone_number_id from organizations where slug = 'zipicka'
--          ),
--          whatsapp_business_account_id = (
--            select whatsapp_business_account_id from organizations where slug = 'zipicka'
--          ),
--          accepts_shared_number = true
--    where slug in ('juris-prime', 'juris-prime-legal', 'sfs-international')
--      and is_active = true;
--
-- atif-ali-production is left out on purpose: its website is offline, so it has
-- no knowledge base and an agent routed there could only answer from the system
-- prompt. Add it once there is something for it to answer from.
--
-- To turn it back off, restore each tenant's own (or empty) phone number id.
