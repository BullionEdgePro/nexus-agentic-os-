-- ============================================================
-- Tags on a conversation
-- ============================================================
--
-- A team inbox needs to label a thread — "rate customer", "callback",
-- "complaint" — so it can be found, filtered and routed by something other than
-- the customer's name. This is the smallest thing that does that: a text array
-- on the conversation, free to hold whatever a business finds useful.
--
-- A per-conversation array rather than an org-level tag catalogue with a join,
-- on purpose and for now: the catalogue (shared colours, rename-everywhere,
-- delete-a-tag) is a real feature, but it is not THIS feature, and starting with
-- the array means a person can tag a conversation today. Suggestions are read
-- back with `select distinct unnest(tags)` over the org, so labels still
-- converge without a table to manage them.
--
-- NOT NULL DEFAULT '{}' so every conversation reads as "no tags" rather than
-- null, and code never has to guard the difference. A GIN index makes
-- "conversations tagged X" a real query rather than a scan, for when filtering
-- moves server-side.

alter table conversations
  add column if not exists tags text[] not null default '{}';

create index if not exists conversations_tags_gin
  on conversations using gin (tags);
