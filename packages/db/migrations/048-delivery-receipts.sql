-- Every outbound message in this database claims it was sent. None of them knows.
--
-- Measured on production the day this was written: 24 outbound rows, all
-- `status = 'sent'`, and **0 with a `wa_message_id`**. Both facts have the same
-- cause. `insertOutboundMessage` writes the literal 'sent' into the status
-- column, and `sendWhatsAppText` throws away the response body — so Meta's
-- answer, the `wamid` it returns on acceptance, has never been stored.
--
-- The vocabulary was always there. `messages_status_check` has allowed
-- queued/sent/delivered/read/failed since the schema was written, and inbound
-- rows do carry their wamid. Only the outbound half was never connected.
--
-- WHAT THAT COSTS. A 200 from the Graph API means Meta ACCEPTED the message,
-- not that anybody received it. Delivery is reported afterwards, on the same
-- webhook the inbound messages arrive on — `value.statuses` — and this platform
-- counts those in a log line and drops them. So a reply that Meta accepted and
-- then failed to deliver is indistinguishable, in the inbox and in the
-- database, from one the customer read. The business sees a sent message and a
-- customer who never replied.
--
-- That is not hypothetical for this account. Business verification is still in
-- review, messaging limits apply, and §2.5 of the architecture warns that
-- quality-rating decay restricts numbers. The first symptom of a restricted
-- number is sends being accepted and not delivered, which is exactly the state
-- this schema cannot currently represent.
--
-- No new column is needed for the status itself, and none is added. What is
-- missing is the evidence beside it.

-- Meta's own words when it says a message failed. Kept verbatim rather than
-- classified: the useful ones are specific ("re-engagement message" outside the
-- 24-hour window, "recipient has not accepted our new terms"), and a code this
-- platform invented for them would lose exactly the part somebody needs.
alter table messages add column if not exists delivery_error text;

-- When the status last moved. `created_at` answers when we sent it, which stops
-- being the same question the moment there is a lifecycle: an operator asking
-- "has this been stuck for an hour" needs the time of the last word from Meta,
-- and a message with no word at all is the case it is looking for.
alter table messages add column if not exists delivery_updated_at timestamptz;

-- The status webhook arrives carrying a wamid and nothing else that identifies
-- the message, so this is the only lookup path there is.
--
-- NOT unique, deliberately. It would be tempting — a wamid is globally unique
-- at Meta — but Meta redelivers webhooks, and a duplicate inbound insert that
-- currently produces a redundant row would start producing a constraint
-- violation, a failed job, and a retry loop, in the reply path, to fix a
-- cosmetic problem. Deduplication belongs with the inbound insert and an
-- `on conflict`, not smuggled in underneath a feature about outbound delivery.
create index if not exists messages_wa_message_id_idx
  on messages (wa_message_id)
  where wa_message_id is not null;

-- What the operator sweeps: outbound messages that failed, or that Meta accepted
-- and has said nothing about since.
create index if not exists messages_undelivered_idx
  on messages (organization_id, created_at desc)
  where direction = 'outbound' and status in ('queued', 'failed');

-- Nothing deletes a message, and nothing should be able to.
--
-- Same reasoning as 042 for `catalog_installs`, and it matters more here: these
-- rows are the record of what a business actually said to a customer. Every
-- other guarantee in this system — the governance evaluation attached to a
-- reply, the handover brief, the quality rollups, an operator's evidence — is
-- computed from them, and a grant nothing uses is a grant that only ever gets
-- exercised by accident or by injection. The application still needs UPDATE:
-- that is how a delivery receipt lands.
revoke all on messages from nexus_app;
grant select, insert, update on messages to nexus_app;
