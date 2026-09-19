-- ============================================================
-- Facebook Page messaging joins the channel set
-- ============================================================
--
-- Instagram was already a permitted channel (migration 085); a Facebook Page's
-- Messenger conversations are the same kind of thing, so 'facebook' joins the
-- allowed set. Like the others it stays dormant until its Meta permissions are
-- granted (pages_messaging) and a Page is connected — this only teaches the
-- database the value so a Facebook conversation is a first-class row the moment
-- the integration goes live. Additive and re-runnable; no existing row changes.

alter table conversations drop constraint if exists conversations_channel_known;
alter table conversations
  add constraint conversations_channel_known
  check (channel in ('whatsapp', 'email', 'sms', 'instagram', 'phone', 'facebook'));

do $$
begin
  raise notice 'conversations.channel now allows facebook';
end $$;
