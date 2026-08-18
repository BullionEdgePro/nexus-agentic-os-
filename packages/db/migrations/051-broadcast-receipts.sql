-- A campaign says 'sent' and means the same thing 'sent' used to mean on a reply.
--
-- `broadcast_recipients.status` has allowed pending / sent / delivered / failed
-- since the table was written, and **nothing has ever written 'delivered'**.
-- The send path calls `updateBroadcastRecipientStatus(recipientId, 'sent')` the
-- moment the Graph API returns 2xx, and 2xx means ACCEPTED. That is exactly the
-- conflation migration 048 removed from replies, still in place for campaigns —
-- the vocabulary anticipating a lifecycle nobody wired up.
--
-- It matters more here than it did there. A reply goes to somebody who messaged
-- thirty seconds ago, so the session window is open and delivery is close to
-- certain. A campaign is the opposite by definition: it goes to people who have
-- NOT written in 24 hours, which is the population most likely to have changed
-- number, blocked the business, or never opted in. Those are the sends Meta
-- accepts and then drops, and "sent" is currently the last thing this platform
-- would ever know about them.
--
-- WRITTEN BEFORE IT COSTS ANYTHING, and that is worth saying plainly:
-- `broadcast_recipients` has ZERO rows today. No campaign has been sent. Every
-- other defect fixed this session was found after it had already cost a customer
-- something; this one is the same shape, found by reading the send path rather
-- than by an outage, and closed while the table is empty.

-- Meta's receipt, which the send path already had and was discarding.
-- `sendWhatsAppTemplate` was changed on 2026-08-17 to return the wamid and the
-- broadcast caller ignored it — the reply path was wired and the campaign path
-- was not.
alter table broadcast_recipients add column if not exists wa_message_id text;

-- Meta's own words when it rejects one. On this path they are the most useful
-- field on the table: "re-engagement message" means the template was sent
-- outside the window, and that is a mistake about the CAMPAIGN rather than
-- about the recipient.
alter table broadcast_recipients add column if not exists delivery_error text;

-- The status webhook arrives with a wamid and nothing else. Not unique, for the
-- same reason as migration 048's index on `messages`: Meta redelivers, and a
-- constraint violation on the reply path to fix a cosmetic duplicate is a bad
-- trade.
create index if not exists broadcast_recipients_wa_message_id_idx
  on broadcast_recipients (wa_message_id)
  where wa_message_id is not null;

-- The application already reads and writes this table; nothing here changes who
-- may touch it.
