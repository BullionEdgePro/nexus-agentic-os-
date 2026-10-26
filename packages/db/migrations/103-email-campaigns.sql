-- ============================================================
-- A campaign goes by email or by WhatsApp
-- ============================================================
--
-- 26 Oct 2026. The owner: "fix the bulk messaging separated for email and
-- whatsapp". Ralph's only campaign (22 Oct) was queued to 57 email-only
-- customers on WhatsApp and reached nobody; the audience was then narrowed to
-- WhatsApp numbers, which left every email customer unreachable by any campaign.
-- Spec: docs/superpowers/specs/2026-10-26-email-campaigns-design.md
--
-- One campaigns table with a channel, rather than a second system: history, the
-- breaker and the reports stay shared; audience, sender and queue are per channel.
--
-- Additive only: every new column is nullable or defaulted, so the code running
-- before the deploy keeps working. Applied as the owner role before the code.

-- ---- campaigns ----------------------------------------------------------------
alter table broadcasts add column if not exists channel text not null default 'whatsapp';
alter table broadcasts drop constraint if exists broadcasts_channel_check;
alter table broadcasts add constraint broadcasts_channel_check check (channel in ('whatsapp', 'email'));

-- An email campaign has no Meta template: what it says is its own subject and body.
alter table broadcasts alter column template_id drop not null;
alter table broadcasts add column if not exists email_subject text;
alter table broadcasts add column if not exists email_body text;
-- Stamped at send so "what did this go out from" never changes afterwards.
alter table broadcasts add column if not exists from_mailbox text;
alter table broadcasts add column if not exists from_mailbox_employee_id uuid references employees(id) on delete set null;

alter table broadcasts drop constraint if exists broadcasts_channel_content_check;
alter table broadcasts add constraint broadcasts_channel_content_check check (
  (channel = 'whatsapp' and template_id is not null)
  or (channel = 'email' and email_subject is not null and email_body is not null)
);

-- Stopped: closed for good by a person. Its untried recipients stay 'pending'
-- and read as "not sent" — nothing was tried for them.
alter table broadcasts drop constraint if exists broadcasts_status_check;
alter table broadcasts
  add constraint broadcasts_status_check
  check (status in ('draft', 'scheduled', 'sending', 'completed', 'failed', 'paused', 'stopped'));

-- ---- recipients -----------------------------------------------------------------
-- The address frozen when the campaign was queued: a later edit to the contact
-- must not redirect a message already committed to.
alter table broadcast_recipients add column if not exists to_address text;
alter table broadcast_recipients add column if not exists email_message_id text;
-- Past the mailbox's daily limit a recipient waits for a later day rather than
-- being refused; this says when.
alter table broadcast_recipients add column if not exists send_after timestamptz;
-- Per recipient, so an unsubscribe link names one person in one campaign and
-- reveals nothing else.
alter table broadcast_recipients add column if not exists unsubscribe_token uuid not null default gen_random_uuid();
create unique index if not exists idx_broadcast_recipients_unsubscribe_token
  on broadcast_recipients (unsubscribe_token);
-- A bounce names an address; find what was sent to it, newest first.
create index if not exists idx_broadcast_recipients_to_address
  on broadcast_recipients (to_address, sent_at desc) where to_address is not null;

-- ---- customers ------------------------------------------------------------------
-- Email campaigns only. Unsubscribing from campaign emails leaves WhatsApp and
-- ordinary email conversations exactly as they were.
alter table contacts add column if not exists email_campaigns_opted_out_at timestamptz;
-- An address that bounced is skipped by every later campaign.
alter table contacts add column if not exists email_bounced_at timestamptz;
