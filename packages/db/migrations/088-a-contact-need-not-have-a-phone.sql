-- A contact need not have a phone.
--
-- ============================================================
-- CHANNEL-AGNOSTIC CONTACT IDENTITY
-- ============================================================
--
-- Until now a contact WAS a WhatsApp number: `wa_id` was NOT NULL and the only
-- identity a person could have. That is fine while every conversation arrives on
-- WhatsApp, and it is exactly what blocks the two channels being built. A
-- Messenger sender is a page-scoped id (PSID) and an Instagram sender an IGSID;
-- neither is a phone number, and the person behind them may never have messaged
-- the business on WhatsApp at all. An email-only contact has no phone either.
--
-- So a contact grows a second, channel-scoped way to be identified — WITHOUT
-- disturbing the WhatsApp one that every existing row and every existing query
-- depends on:
--
--   * `wa_id` becomes nullable. The old `unique (organization_id, wa_id)` is
--     LEFT IN PLACE: Postgres treats NULLs as distinct, so it still enforces one
--     row per WhatsApp number per business while now permitting rows that have no
--     wa_id at all. Every `insert ... on conflict (organization_id, wa_id)` in
--     the code keeps resolving against that same constraint, unchanged.
--
--   * `channel` + `external_id` are the new identity. `channel` says which id
--     space `external_id` lives in (a PSID and an IGSID that happen to be equal
--     are still two different people), and a partial unique index enforces one
--     row per (business, channel, external_id). WhatsApp rows leave `external_id`
--     null and are untouched by it.
--
--   * A CHECK makes the two ways exhaustive: every contact carries at least one
--     identity, so a row can never exist that no channel can reach.
--
-- The default `channel = 'whatsapp'` is what makes this safe for the ~20 rows
-- already in production: they backfill to the channel they were always on, keep
-- their wa_id, and satisfy the new CHECK on the wa_id side.

alter table contacts alter column wa_id drop not null;

alter table contacts add column channel text not null default 'whatsapp'
  check (channel in ('whatsapp', 'email', 'sms', 'instagram', 'phone', 'facebook'));

alter table contacts add column external_id text;

-- One row per person per channel, for the channels identified by external_id.
-- Partial (external_id is not null) so it never touches WhatsApp-only rows.
create unique index contacts_external_identity_key
  on contacts (organization_id, channel, external_id)
  where external_id is not null;

-- A contact is reachable on at least one channel, always.
alter table contacts add constraint contacts_has_identity
  check (wa_id is not null or external_id is not null);
