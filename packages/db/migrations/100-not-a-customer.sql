-- ============================================================
-- Not a customer
-- ============================================================
--
-- 24 Oct 2026. A business mailbox counted platform notifications (Shopify,
-- noon, Amazon, Google, Carrefour Marketplace) and cold pitches as customers
-- waiting, burying four real customers among them for weeks. A contact can now
-- be marked "not a customer": out of every waiting count, still readable.
--
--   reason 'platform' — set as the mail arrives, from a known platform domain
--   reason 'marked'   — a person tapped "Not a customer" in the inbox
--
-- On the CONTACT, not the conversation, so a sender who writes again stays
-- out of the counts. Cleared by the undo. Applied as the owner role before the
-- code that reads it is deployed.

alter table contacts add column if not exists not_a_customer_at timestamptz;
alter table contacts add column if not exists not_a_customer_reason text;
alter table contacts add column if not exists not_a_customer_by text;

alter table contacts drop constraint if exists contacts_not_a_customer_reason_check;
alter table contacts
  add constraint contacts_not_a_customer_reason_check
  check (not_a_customer_reason is null or not_a_customer_reason in ('platform', 'marked'));
