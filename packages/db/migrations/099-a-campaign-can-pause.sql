-- ============================================================
-- A campaign can pause
-- ============================================================
--
-- 22 Oct 2026. A campaign whose messages are being refused used to run to its
-- last recipient, and every refusal counts against the sending number's
-- standing with WhatsApp — on a staff member's own number, the line their
-- customers reach them on. The worker now stops a campaign once more than half
-- of at least ten attempts have failed, and records that here.
--
-- The recipients it had not reached stay 'pending', not 'failed': nothing was
-- tried for them, and a resumed or re-sent campaign must be able to tell them
-- from the people WhatsApp actually refused.
--
-- Applied as the owner role before the code that writes it is deployed.

alter table broadcasts drop constraint if exists broadcasts_status_check;
alter table broadcasts
  add constraint broadcasts_status_check
  check (status in ('draft', 'scheduled', 'sending', 'completed', 'failed', 'paused'));
