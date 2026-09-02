-- ============================================================
-- Which number a conversation is actually on
-- ============================================================
--
-- A reply has to leave from the number the customer messaged. WhatsApp treats a
-- send from a different number as a NEW thread on that other number, so a reply
-- from the shared line to someone who wrote to a staff member's own number would
-- reach them as a stranger.
--
-- Until multi-number, every conversation was on the one shared company number,
-- so findConversationById could take it straight from the organization. Now a
-- conversation can be on a staff member's dedicated number instead, so it has to
-- be remembered per conversation.
--
-- NULLABLE, and read as coalesce(phone_number_id, org's shared number): every
-- existing row is null and correctly falls back to the shared line, and a
-- shared-number conversation handed to a staff member who happens to own a
-- dedicated number still replies from the shared line — because the number is a
-- fact about where the conversation IS, not about who is holding it. Only the
-- staff-number inbound path sets it. Re-runnable.

alter table conversations
  add column if not exists phone_number_id text;
