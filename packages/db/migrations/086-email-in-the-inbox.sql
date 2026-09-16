-- ============================================================
-- Email lands in the inbox as its own channel
-- ============================================================
--
-- A conversation on channel 'email' (migration 085) needs its messages to carry
-- the one thing a WhatsApp message never had: the sending mail system's own
-- message id. Two reasons, both about not lying to the person reading the thread:
--
--   1. Dedup. The email channel is populated by SYNCING a staff member's Gmail —
--      pulling the thread with a client into a conversation. A sync that runs
--      again (a minute later, a day later) must recognise a message it already
--      stored rather than append a second copy. Gmail's per-message id is that
--      key, unique per mailbox and stable across fetches.
--
--   2. Threading. The Gmail thread id groups a back-and-forth, so a reply can be
--      matched to the conversation it belongs to rather than starting a new one.
--
-- Both nullable and only ever set on email messages, so every existing WhatsApp
-- row is untouched and correct. Re-runnable.

alter table messages add column if not exists email_message_id text;
alter table messages add column if not exists email_thread_id  text;

-- The dedup key. Partial + unique so a re-sync cannot double a message, while the
-- millions of WhatsApp rows with a null here are not forced to be distinct.
create unique index if not exists idx_messages_email_message_id
  on messages (email_message_id)
  where email_message_id is not null;

-- Finding an email conversation to append to, by the thread it tracks.
create index if not exists idx_messages_email_thread
  on messages (email_thread_id)
  where email_thread_id is not null;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'messages' and column_name = 'email_message_id'
  ) then
    raise exception 'messages.email_message_id was not added';
  end if;
  raise notice 'messages ready for the email channel (email_message_id, email_thread_id)';
end $$;
