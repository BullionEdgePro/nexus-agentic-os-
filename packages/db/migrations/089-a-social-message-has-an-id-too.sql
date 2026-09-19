-- A Messenger/Instagram message carries its own id, so a redelivery is not a copy.
--
-- ============================================================
-- DEDUP FOR THE FACEBOOK PAGE + INSTAGRAM CHANNELS
-- ============================================================
--
-- A conversation on channel 'facebook' or 'instagram' (migrations 087/085) is
-- fed by Meta webhook deliveries, and Meta redelivers: the same message arrives
-- again on a retry, and the same delivery can reach both the api and a future
-- backfill. Each inbound must be recognised the second time and stored once.
--
-- Meta's message id (the `mid`) is that key — its opaque per-message id, stable
-- across retries, exactly as a `wamid` is on WhatsApp and a Gmail message id is
-- on the email channel (migration 086). This mirrors 086's shape precisely: a
-- nullable column, unique only where set, so every existing WhatsApp and email
-- row (null here) is untouched and correct. Re-runnable.

alter table messages add column if not exists social_message_id text;

-- The dedup key. Partial + unique so a redelivery cannot double a message, while
-- the millions of rows on other channels with a null here are not forced distinct.
create unique index if not exists idx_messages_social_message_id
  on messages (social_message_id)
  where social_message_id is not null;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_name = 'messages' and column_name = 'social_message_id'
  ) then
    raise exception 'messages.social_message_id was not added';
  end if;
  raise notice 'messages ready for the Facebook/Instagram channels (social_message_id)';
end $$;
